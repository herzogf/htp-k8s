package server

import (
	"log"
	"net"
	"net/http"
	"strings"
)

// This file implements the Host-header allowlist for /ws and /api (issue
// #163, ADR-0013) — a defense against DNS rebinding that a same-origin check
// (including gorilla's own default CheckOrigin, see server.go) cannot
// provide on its own, and that must be enforced UNCONDITIONALLY, regardless
// of whether a request carries an Origin header at all. Full reasoning —
// including why gating on Origin's presence is a bypass rather than a
// mitigation, and why an IP-literal or localhost/*.localhost Host is safe to
// trust unconditionally — lives in ADR-0013; not restated here.

// AllowedHosts is the set of extra HTTP Host-header hostnames /ws and /api
// trust, on top of what Permits always allows regardless of configuration.
// The zero value AllowedHosts{} is valid and still enforces those
// unconditional forms; NewAllowedHosts additionally admits -allowed-hosts
// entries.
type AllowedHosts struct {
	hosts map[string]struct{}
}

// NewAllowedHosts builds an AllowedHosts trusting extra (typically from
// -allowed-hosts/HTP_K8S_ALLOWED_HOSTS) on top of the forms Permits always
// allows on its own. Entries are compared by hostname only — any port on
// either side is ignored, matching Permits — and literally: wildcards such as
// "*.example.com" are not supported.
func NewAllowedHosts(extra []string) AllowedHosts {
	a := AllowedHosts{hosts: make(map[string]struct{})}
	for _, h := range extra {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		a.add(hostOnly(h))
	}
	return a
}

func (a AllowedHosts) add(host string) {
	a.hosts[strings.ToLower(host)] = struct{}{}
}

// Permits reports whether hostHeader — an HTTP request's Host (e.g. r.Host)
// — names a trusted host, ignoring any port. Two forms are ALWAYS trusted,
// regardless of AllowedHosts' configured entries (see ADR-0013 for the full
// reasoning behind both):
//
//   - an IP-address literal (v4 or v6). DNS rebinding works by resolving a
//     *name* the attacker controls to the target's address; a Host that's
//     already a bare IP was never routed through DNS at all, so there is no
//     name for an attacker to rebind. This also means a wildcard bind
//     (-addr :8080 — the only option inside a container) needs no extra
//     configuration for a browser reaching it by IP address.
//   - "localhost" or any "*.localhost" subdomain. RFC 6761 §6.3 reserves the
//     whole ".localhost" TLD to always resolve to loopback; this mirrors
//     Vite's own dev-server Host check (isHostAllowedInternal in
//     vite/dist/node/chunks/node.js), which trusts the identical two forms
//     unconditionally, with no Origin gate either.
//
// Anything else must be on the explicit list NewAllowedHosts builds from
// -allowed-hosts/HTP_K8S_ALLOWED_HOSTS. Matching is exact against the two
// forms above and against the configured list — no normalization beyond
// stripping a port and lower-casing — so near-miss spellings fail closed
// rather than being coerced into a match: a trailing-dot FQDN ("localhost.",
// "127.0.0.1.") is rejected, not treated as equivalent to the dotless form.
func (a AllowedHosts) Permits(hostHeader string) bool {
	host := strings.ToLower(hostOnly(hostHeader))
	if host == "" {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	_, ok := a.hosts[host]
	return ok
}

// hostOnly strips a trailing ":port" from a host[:port] string, tolerating a
// bracketed IPv6 literal with or without a port ("[::1]:8080" or "[::1]").
// Given a bare hostname with no port, it returns s unchanged.
func hostOnly(s string) string {
	if host, _, err := net.SplitHostPort(s); err == nil {
		return host
	}
	return strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
}

// gatedPath reports whether path carries cluster data and must be checked
// against the Host allowlist: /ws and every /api/* route. Matching by prefix
// here — rather than wrapping each mux.Handle registration individually in
// NewHandler — means a future /api/* route is protected automatically:
// there's no per-route wrapper to remember or forget when adding one.
// Everything else (the health check, and the static frontend served at "/")
// carries no cluster data and is exempt.
func gatedPath(path string) bool {
	return path == "/ws" || strings.HasPrefix(path, "/api/")
}

// hostAllowlist wraps next (the whole handler, not an individual route — see
// NewHandler) with the Host-header allowlist check on gatedPath requests: a
// request whose Host isn't in allowed is rejected with 403 before reaching
// next, UNCONDITIONALLY — regardless of whether the request carries an
// Origin header, and regardless of what it says if present.
//
// This does NOT exempt requests with no Origin header, unlike an earlier
// version of this middleware. That exemption was itself the bypass: per the
// WHATWG Fetch spec ("Append a request Origin header"), a browser only
// appends Origin when response tainting is "cors" or the method isn't
// GET/HEAD. A same-origin GET — exactly what fetch()/EventSource issue
// against /api, including the SSE log tail — never carries one. A
// DNS-rebound page's fetch('/api/...') is a plain same-origin GET with no
// Origin header at all, so gating on Origin's presence would let it straight
// through to a Host check it never triggers. WebSocket is the one request
// type Fetch calls out as always carrying Origin, which is why that
// exemption looked safe when only /ws was considered — it wasn't, for /api.
// Verified empirically against a real browser and this handler.
//
// It also intentionally does not compare Origin to Host itself (that's
// upgrader's job for /ws, via gorilla's default CheckOrigin); it only asks
// "is Host one we trust", which is what stops DNS rebinding — a rebound
// request's Origin and Host, when Origin is present at all, both name the
// attacker's host, so an Origin-equals-Host check alone would let it
// through.
func hostAllowlist(allowed AllowedHosts, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !gatedPath(r.URL.Path) || allowed.Permits(r.Host) {
			next.ServeHTTP(w, r)
			return
		}
		log.Printf("rejected %s %s: Host %q is not in the allowed-hosts list (Origin %q) — if this is a reverse proxy or a DNS-name deployment, set -allowed-hosts (or HTP_K8S_ALLOWED_HOSTS) to trust it", r.Method, r.URL.Path, r.Host, r.Header.Get("Origin"))
		http.Error(w, "host not allowed — see -allowed-hosts", http.StatusForbidden)
	})
}
