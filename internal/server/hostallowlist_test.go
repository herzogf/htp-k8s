package server_test

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

// --- AllowedHosts.Permits: the unconditional trust rules -------------------

// TestAllowedHosts_IPLiteralAlwaysTrusted proves any IP-address-literal Host
// (v4 or v6, any port, and regardless of AllowedHosts' configured entries) is
// always trusted. This is what makes a wildcard -addr bind (":8080" — the
// only option inside a container; see all three docker run recipes in
// README.md) reachable by IP address with zero -allowed-hosts configuration
// (issue #163 / ADR-0013): DNS rebinding requires resolving a *name*, and a
// Host that's already a bare IP was never routed through DNS. 0.0.0.0 and ::
// are deliberately included — they're IP literals like any other, and there
// is no addr-derived special case left to disagree with that.
func TestAllowedHosts_IPLiteralAlwaysTrusted(t *testing.T) {
	var allowed server.AllowedHosts // zero value: nothing explicitly configured
	for _, host := range []string{
		"127.0.0.1:8080", "127.0.0.1:9090", "127.0.0.1",
		"192.168.1.5:8080", "192.168.1.5",
		"0.0.0.0:8080", "0.0.0.0",
		"[::1]:8080", "[::1]", "::1",
		"[::]:8080", "[::]",
		"10.0.0.1:9999",
	} {
		if !allowed.Permits(host) {
			t.Errorf("Permits(%q) = false, want true (IP-literal host)", host)
		}
	}
}

// TestAllowedHosts_LocalhostAlwaysTrusted proves "localhost" and any
// "*.localhost" subdomain are always trusted, mirroring Vite's own
// dev-server Host check (isHostAllowedInternal).
func TestAllowedHosts_LocalhostAlwaysTrusted(t *testing.T) {
	var allowed server.AllowedHosts
	for _, host := range []string{
		"localhost:8080", "localhost:5173", "localhost",
		"foo.localhost:8080", "foo.localhost", "a.b.localhost",
	} {
		if !allowed.Permits(host) {
			t.Errorf("Permits(%q) = false, want true (localhost form)", host)
		}
	}
}

// TestAllowedHosts_DNSNameNotAutoTrusted proves an ordinary DNS name — not an
// IP literal, not localhost or a *.localhost subdomain — is NOT trusted
// without an explicit -allowed-hosts entry. Includes near-miss strings
// ("notlocalhost", "localhostx") that a naive substring (rather than exact
// hostname / dotted-suffix) match could wrongly admit.
func TestAllowedHosts_DNSNameNotAutoTrusted(t *testing.T) {
	var allowed server.AllowedHosts
	for _, host := range []string{
		"evil.com:8080", "example.com", "notlocalhost:8080", "localhostx",
		"127.0.0.1.evil.com:8080", // substring trap: contains an IP literal as text, isn't one
	} {
		if allowed.Permits(host) {
			t.Errorf("Permits(%q) = true, want false (DNS name, not IP-literal or localhost)", host)
		}
	}
}

// TestNewAllowedHosts_ExplicitExtraHosts proves -allowed-hosts entries are
// trusted, with any port on the entry itself or the checked value ignored.
func TestNewAllowedHosts_ExplicitExtraHosts(t *testing.T) {
	allowed := server.NewAllowedHosts([]string{"k8s-viewer.example.com", " reverse-proxy.internal:8443 ", ""})
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

// --- hostAllowlist middleware: request-level behaviour ----------------------

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

// wsAllowlistConfig builds a server.Config serving a fixed snapshot behind
// the given AllowedHosts.
func wsAllowlistConfig(allowed server.AllowedHosts) server.Config {
	cfg := testConfig
	cfg.AllowedHosts = allowed
	return cfg
}

// TestHostAllowlist_TrustedHostNoOrigin_Passes proves non-browser tooling
// (curl, monitoring, the e2e harness) — which typically carries no Origin
// header at all — still works, on both /ws and /api, PROVIDED it reaches the
// server by a trusted Host (loopback/IP-literal in practice). It works
// because the Host is trusted, not because Origin is absent: see
// TestHostAllowlist_UntrustedHostNoOrigin_RejectedOnAPI immediately below for
// the case that distinguishes the two (an earlier version of this file had a
// test that conflated them and, in doing so, pinned a real bypass as
// correct — see ADR-0013).
func TestHostAllowlist_TrustedHostNoOrigin_Passes(t *testing.T) {
	cfg := wsAllowlistConfig(server.AllowedHosts{}) // nothing explicitly configured
	handler := server.NewHandler(cfg)

	t.Run("ws upgrade, no Origin, real loopback Host", func(t *testing.T) {
		ts := httptest.NewServer(handler)
		defer ts.Close()
		conn, resp, err := dialWS(t, ts.URL, nil)
		if err != nil {
			t.Fatalf("dial with no Origin header against a real (loopback) Host should succeed, got: %v", err)
		}
		defer resp.Body.Close()
		defer conn.Close()
	})

	t.Run("api, no Origin, IP-literal Host", func(t *testing.T) {
		req := trustedRequest(http.MethodGet, "/api/config")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 for a no-Origin /api request to a trusted Host", rec.Code)
		}
	})
}

// TestHostAllowlist_UntrustedHostNoOrigin_RejectedOnAPI is the exact shape a
// real DNS-rebinding attack against /api looks like on the wire, and the case
// a naive "only check Host when Origin is present" implementation gets wrong.
// Per the WHATWG Fetch spec ("Append a request Origin header"), a browser
// only appends Origin when response tainting is "cors" or the method isn't
// GET/HEAD — a same-origin GET (exactly what fetch()/EventSource issue)
// never carries one, so a DNS-rebound page's same-origin GET against /api has
// NO Origin header and an untrusted Host. Gating on Origin's presence would
// let this straight through to a Host check it never triggers; gating on
// Host alone, unconditionally, is what catches it.
func TestHostAllowlist_UntrustedHostNoOrigin_RejectedOnAPI(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil)) // does not trust evil.com
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req.Host = "evil.com:8080"
	// Deliberately no Origin header — the real rebinding shape against /api.
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a no-Origin /api GET to an untrusted Host", rec.Code)
	}
}

// TestHostAllowlist_UntrustedHostNoOrigin_RejectedOnLogtailSSE mirrors the
// above for the SSE log-tail route specifically — the highest-value leak
// (live pod log content) and a route added after the original /ws-only
// design, so it needs its own coverage rather than relying on the /api/config
// test to stand in for every /api/* route.
func TestHostAllowlist_UntrustedHostNoOrigin_RejectedOnLogtailSSE(t *testing.T) {
	cfg := server.Config{
		AllowedHosts: server.NewAllowedHosts(nil),
		PodLogTail: func(_ context.Context, ns, name string, emit func(scene.LogTail)) error {
			emit(scene.LogTail{Lines: []string{"leaked-secret-log-line"}})
			return nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/pods/default/web/logtail", nil)
	req.Host = "evil.com:8080"
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a no-Origin SSE log-tail GET to an untrusted Host", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "leaked-secret-log-line") {
		t.Fatal("log-tail body leaked pod log content despite an untrusted Host")
	}
}

// TestHostAllowlist_UntrustedHostRejectedOnWS proves /ws rejects an untrusted
// Host regardless of whether (or what) Origin is present — the allowlist
// check runs before, and independent of, gorilla's own Origin/Host
// comparison inside Upgrade.
func TestHostAllowlist_UntrustedHostRejectedOnWS(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil)) // does not trust evil.com
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	cases := []struct {
		name   string
		header http.Header
	}{
		{"no Origin header", nil},
		{"Origin matches the rebound Host (the real rebinding shape)", http.Header{"Origin": {"http://evil.com:8080"}}},
		{"Origin is a different foreign host", http.Header{"Origin": {"http://other-evil.com"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := dialWSWithHost(t, ts.URL, tc.header, "evil.com:8080")
			if err == nil {
				t.Fatal("dial with an untrusted Host succeeded, want rejection")
			}
		})
	}
}

// TestHostAllowlist_ForeignOrigin_RejectedOnWS proves a plain cross-site
// request — a foreign Origin against the real (trusted) Host — is rejected
// opening /ws by gorilla's own default (Origin must equal Host when
// present), exercised through the full handler stack: the Host allowlist
// permits it (Host itself is trusted), and the upgrader's own check is what
// catches the Origin mismatch one layer in.
func TestHostAllowlist_ForeignOrigin_RejectedOnWS(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil)) // loopback always trusted regardless
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	_, _, err := dialWS(t, ts.URL, http.Header{"Origin": {"http://evil.com"}})
	if err == nil {
		t.Fatal("dial with a foreign Origin against a trusted Host succeeded, want rejection")
	}
}

// TestHostAllowlist_TrustedHostWithOrigin_AllowedOnAPI proves a legitimate
// same-origin browser request to /api (Origin present, Host trusted) is
// still served — the allowlist must not overreach into rejecting normal
// traffic just because Origin happens to be present.
func TestHostAllowlist_TrustedHostWithOrigin_AllowedOnAPI(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil))
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", "http://127.0.0.1:8080")
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a legitimate same-origin /api request", rec.Code)
	}
}

// TestHostAllowlist_ProtectsUnregisteredAPIRoutesAutomatically proves the
// Host allowlist is enforced by wrapping the whole handler and matching the
// URL path (gatedPath), not by wrapping each mux.Handle registration
// individually — so a hypothetical future /api/* route, added without
// remembering a per-route wrapper, is still denied by default rather than
// silently falling through to the ServeMux (which would 404 it with no Host
// check at all).
func TestHostAllowlist_ProtectsUnregisteredAPIRoutesAutomatically(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil))
	req := httptest.NewRequest(http.MethodGet, "/api/some-future-route", nil)
	req.Host = "evil.com:8080"
	rec := httptest.NewRecorder()

	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (Host allowlist should gate this before mux routing/404), body %q", rec.Code, rec.Body.String())
	}
}

// TestHostAllowlist_HealthzAndRootExempt proves /healthz and the static
// frontend at "/" are reachable regardless of Host — they carry no cluster
// data and must stay available (e.g. for a Kubernetes readiness probe) even
// with an untrusted-looking Host and no -allowed-hosts configured.
func TestHostAllowlist_HealthzAndRootExempt(t *testing.T) {
	cfg := wsAllowlistConfig(server.NewAllowedHosts(nil))
	handler := server.NewHandler(cfg)

	for _, path := range []string{"/healthz", "/"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = "evil.com:8080"
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code == http.StatusForbidden {
			t.Errorf("%s with an untrusted Host = 403, want it exempt from the Host allowlist", path)
		}
	}
}

// TestHostAllowlist_RealListener_WildcardBindReachableByIP_NoConfig proves,
// over a REAL TCP connection (Host generated by Go's real HTTP client from
// the address it actually dialed, not a hand-set r.Host) with no
// -allowed-hosts configured, that a server is reachable by a client
// connecting via a concrete IP address. This is the exact shape a container
// deployment needs: -addr :8080 (a wildcard bind — the only option inside a
// container; see all three docker run recipes in README.md) is reached from
// outside by an IP address, e.g. http://192.168.1.5:8080, with nothing
// configured. Loopback is used here only for test portability (no stable
// non-loopback interface in every CI sandbox); the mechanism being proved —
// IP-literal Host trust — is address-family/scope agnostic, so this
// generalises. Unlike the rest of this file, this test exercises a real
// listener end to end, closing the "every host-allowlist test is
// unit-level" gap flagged in review.
func TestHostAllowlist_RealListener_WildcardBindReachableByIP_NoConfig(t *testing.T) {
	cfg := server.Config{
		Snapshot:     server.StaticSnapshot(scene.SceneState{ViewMode: scene.ViewModeNamespace}),
		AllowedHosts: server.NewAllowedHosts(nil), // no -allowed-hosts set
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0") // stand-in for a wildcard bind's reachable address
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: server.NewHandler(cfg)}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	resp, err := http.Get("http://" + ln.Addr().String() + "/api/config")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a real client reaching an IP-literal address with no -allowed-hosts configured", resp.StatusCode)
	}
}
