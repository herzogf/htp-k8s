package server_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/server"
)

// dialWS dials ts's /ws endpoint with the given extra request headers (may be
// nil), returning whatever websocket.DefaultDialer.Dial returns.
func dialWS(t *testing.T, tsURL string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(tsURL, "http") + "/ws"
	return websocket.DefaultDialer.Dial(wsURL, header)
}

// dialWSWithHost is dialWS but additionally overrides the HTTP Host header
// sent during the handshake (independent of the address actually dialed) —
// gorilla's Dialer supports this via a "Host" entry in the header map (see
// client.go's DialContext). This is what lets a test simulate a DNS-rebound
// request: the TCP connection genuinely goes to the test server's real
// address, but the Host header claims to be the attacker's rebound name,
// exactly as a real rebinding attack's browser-issued request would look on
// the wire.
func dialWSWithHost(t *testing.T, tsURL string, header http.Header, host string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	if header == nil {
		header = http.Header{}
	}
	header = header.Clone()
	header.Set("Host", host)
	return dialWS(t, tsURL, header)
}

// TestNewAllowedHosts_LoopbackAlwaysTrusted proves the loopback host forms are
// trusted with no configuration at all — an operator running the loopback
// default must not have to pass -allowed-hosts just to use their own app.
func TestNewAllowedHosts_LoopbackAlwaysTrusted(t *testing.T) {
	allowed := server.NewAllowedHosts("127.0.0.1:8080", nil)
	for _, host := range []string{
		"localhost:8080", "localhost:5173", "localhost",
		"127.0.0.1:8080", "127.0.0.1:9090", "127.0.0.1",
		"[::1]:8080", "[::1]", "::1",
	} {
		if !allowed.Permits(host) {
			t.Errorf("Permits(%q) = false, want true (always-trusted loopback form)", host)
		}
	}
}

// TestNewAllowedHosts_ConcreteAddrIPTrusted proves that when -addr names a
// concrete IP literal, that host is trusted automatically (no -allowed-hosts
// needed) — the "PR #160 must not silently reinstate a configuration step"
// requirement.
func TestNewAllowedHosts_ConcreteAddrIPTrusted(t *testing.T) {
	allowed := server.NewAllowedHosts("192.168.1.5:8080", nil)
	if !allowed.Permits("192.168.1.5:8080") {
		t.Error("Permits(bound IP) = false, want true")
	}
	if !allowed.Permits("192.168.1.5:9999") {
		t.Error("Permits(bound IP, different port) = false, want true (port-agnostic)")
	}
	if allowed.Permits("evil.com:8080") {
		t.Error("Permits(unrelated host) = true, want false")
	}
}

// TestNewAllowedHosts_WildcardAddrDerivesNothing proves a wildcard bind
// (":8080", no host) does not auto-trust anything beyond the always-trusted
// loopback forms — it "cannot know its own reachable name" (the grilled
// rationale for why -allowed-hosts exists at all).
func TestNewAllowedHosts_WildcardAddrDerivesNothing(t *testing.T) {
	allowed := server.NewAllowedHosts(":8080", nil)
	if allowed.Permits("192.168.1.5:8080") {
		t.Error("Permits(arbitrary host) = true for a wildcard bind, want false")
	}
	if !allowed.Permits("localhost:8080") {
		t.Error("Permits(localhost) = false even for a wildcard bind, want true (always-trusted)")
	}
}

// TestNewAllowedHosts_ExplicitExtraHosts proves -allowed-hosts entries are
// trusted, with any port on the entry itself or the checked value ignored.
func TestNewAllowedHosts_ExplicitExtraHosts(t *testing.T) {
	allowed := server.NewAllowedHosts(":8080", []string{"k8s-viewer.example.com", " reverse-proxy.internal:8443 ", ""})
	if !allowed.Permits("k8s-viewer.example.com") {
		t.Error("Permits(explicit host, no port) = false, want true")
	}
	if !allowed.Permits("k8s-viewer.example.com:443") {
		t.Error("Permits(explicit host, different port) = false, want true (port-agnostic)")
	}
	if !allowed.Permits("reverse-proxy.internal:9000") {
		t.Error("Permits(explicit host given with a port in -allowed-hosts) = false, want true")
	}
	if allowed.Permits("other.example.com") {
		t.Error("Permits(host not on the allowlist) = true, want false")
	}
}

// wsRebindingConfig serves a fixed snapshot behind the given AllowedHosts, for
// the /ws-side rebinding tests below.
func wsAllowlistConfig(allowed server.AllowedHosts) server.Config {
	cfg := testConfig
	cfg.AllowedHosts = allowed
	return cfg
}

// TestHostAllowlist_NoOriginHeader_Passes proves a request with no Origin
// header (curl, other non-browser tooling, the e2e harness) is never gated by
// the allowlist, on both /ws and /api — even with an empty AllowedHosts,
// which would reject every browser request.
func TestHostAllowlist_NoOriginHeader_Passes(t *testing.T) {
	cfg := wsAllowlistConfig(server.AllowedHosts{}) // trusts nothing
	handler := server.NewHandler(cfg)

	t.Run("ws upgrade with no Origin", func(t *testing.T) {
		ts := httptest.NewServer(handler)
		defer ts.Close()
		conn, resp, err := dialWS(t, ts.URL, nil)
		if err != nil {
			t.Fatalf("dial with no Origin header should succeed, got: %v", err)
		}
		defer resp.Body.Close()
		defer conn.Close()
	})

	t.Run("api with no Origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 for a no-Origin /api request", rec.Code)
		}
	})
}

// TestHostAllowlist_ForeignOrigin_RejectedOnWS proves a plain cross-site
// request — a foreign Origin against the real (trusted) Host — is rejected
// when opening /ws. With CheckOrigin deleted, gorilla's own default
// (Origin must equal Host when present) is what rejects this; this test
// pins that behaviour through the full handler stack, including our
// allowlist wrapper (which permits it, since Host itself is trusted — the
// Origin mismatch is caught one layer in, by the upgrader).
func TestHostAllowlist_ForeignOrigin_RejectedOnWS(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts("127.0.0.1:0", nil)) // loopback always trusted
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	_, _, err := dialWS(t, ts.URL, http.Header{"Origin": {"http://evil.com"}})
	if err == nil {
		t.Fatal("dial with a foreign Origin against a trusted Host succeeded, want rejection")
	}
}

// TestHostAllowlist_RebindingShaped_RejectedOnWS is the case a naive
// same-origin-only implementation passes: Origin and Host match EACH OTHER,
// but name a host that was never configured as trusted (the DNS-rebinding
// shape — see ADR-0013). checkSameOrigin alone would allow this (Origin.Host
// == r.Host); the Host allowlist is what rejects it.
func TestHostAllowlist_RebindingShaped_RejectedOnWS(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts("127.0.0.1:8080", nil)) // does NOT trust evil.com
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	rebindHeader := http.Header{"Origin": {"http://evil.com:8080"}}
	_, _, err := dialWSWithHost(t, ts.URL, rebindHeader, "evil.com:8080")
	if err == nil {
		t.Fatal("dial with rebinding-shaped Origin==Host (untrusted host) succeeded, want rejection")
	}
}

// TestHostAllowlist_RebindingShaped_RejectedOnAPI mirrors the /ws rebinding
// test for /api: Origin and Host match each other but name an untrusted host.
// This is the case the original ticket's "/api is safe, no CORS headers are
// set" reasoning misses — under rebinding the browser treats the response as
// same-origin and can read it, so /api needs the same allowlist as /ws.
func TestHostAllowlist_RebindingShaped_RejectedOnAPI(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts("127.0.0.1:8080", nil))
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req.Host = "evil.com:8080"
	req.Header.Set("Origin", "http://evil.com:8080")
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a rebinding-shaped /api request", rec.Code)
	}
}

// TestHostAllowlist_TrustedHostWithOrigin_AllowedOnAPI proves a legitimate
// same-origin browser request to /api (Origin present, Host trusted) is
// still served — the allowlist must not overreach into rejecting normal
// traffic.
func TestHostAllowlist_TrustedHostWithOrigin_AllowedOnAPI(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts("127.0.0.1:8080", nil))
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", "http://127.0.0.1:8080")
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a legitimate same-origin /api request", rec.Code)
	}
}
