package server

import (
	"log"
	"net"
	"net/http"
	"strings"
)

// This file implements the Host-header allowlist for /ws and /api (issue
// #163, ADR-0013): a second, independent layer of trust alongside the
// WebSocket upgrader's own Origin check (server.go). Deleting the old
// CheckOrigin override and letting gorilla's default (Origin, when present,
// must equal Host) apply closes plain cross-origin access, but it does NOT
// stop DNS rebinding — an attacker who points a short-TTL DNS name at the
// target address makes the victim's browser send an Origin AND a Host that
// both name the attacker's chosen hostname, which a same-origin check alone
// waves through. Closing that requires knowing which Host values are
// actually trustworthy, independent of whatever the request itself claims —
// hence a real allowlist, not a same-origin comparison. It also has to cover
// /api, not just /ws: rebinding defeats /api's "no CORS header" protection
// the same way, since the browser now treats the attacker's origin as
// same-origin with the server.

// alwaysTrustedLoopbackHosts are Host-header hostnames (the part before any
// port) that are trusted regardless of -addr/-allowed-hosts configuration.
// DNS rebinding can make a browser resolve an attacker-chosen *name* to the
// target's IP, but it can never make the browser send a Host header whose
// hostname text is literally one of these — that text comes from the URL the
// victim navigated to, not from DNS resolution, and an attacker doesn't
// control what's in the victim's address bar. Kept lower-case; matching is
// case-insensitive.
var alwaysTrustedLoopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// AllowedHosts is the set of HTTP Host-header hostnames /ws and /api trust
// (see hostAllowlist). Comparison ignores any port on both sides — the
// property being checked is "is this hostname one we recognise as ours",
// which doesn't depend on which port it was reached on. The zero value
// AllowedHosts{} trusts nothing; use NewAllowedHosts to build one with the
// always-trusted loopback forms included.
type AllowedHosts struct {
	hosts map[string]struct{}
}

// NewAllowedHosts builds an AllowedHosts that trusts, with no configuration
// required:
//
//   - the loopback forms in alwaysTrustedLoopbackHosts (any port);
//   - the host addr binds to, when addr names a concrete IP literal (e.g.
//     "192.168.1.5:8080") rather than a wildcard ("0.0.0.0:8080", ":8080") or
//     a DNS hostname — a concrete bind address is, by construction, the
//     server's own real address, so trusting it doesn't reopen the rebinding
//     gap (an attacker can't make DNS resolve to make the Host header's text
//     literally equal to that IP; a request that really does carry it is, by
//     definition, addressed straight at the server, not routed through a
//     rebound name);
//
// plus every hostname in extra (typically from -allowed-hosts/
// HTP_K8S_ALLOWED_HOSTS), for reverse-proxy or DNS-name deployments, or a
// wildcard bind (":8080") that — unlike a concrete IP — can't derive its own
// reachable name automatically. Entries in extra may include a port; it is
// ignored, matching the loopback and addr-derived forms above.
func NewAllowedHosts(addr string, extra []string) AllowedHosts {
	a := AllowedHosts{hosts: make(map[string]struct{})}
	for _, h := range alwaysTrustedLoopbackHosts {
		a.add(h)
	}
	if host, _, err := net.SplitHostPort(addr); err == nil && host != "" {
		if ip := net.ParseIP(host); ip != nil {
			a.add(host)
		}
	}
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

// Permits reports whether hostHeader — an HTTP request's Host (e.g. r.Host),
// or a raw entry from -allowed-hosts — names a trusted host, ignoring any
// port.
func (a AllowedHosts) Permits(hostHeader string) bool {
	_, ok := a.hosts[strings.ToLower(hostOnly(hostHeader))]
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

// hostAllowlist wraps next with the Host-header allowlist check: a request
// carrying an Origin header (the signal that it's browser-issued and could be
// cross-origin, per the Fetch/WebSocket specs — see the package doc above)
// must also carry a Host in allowed, or it is rejected with 403 before
// reaching next. Requests with no Origin header pass through unchecked —
// curl, other non-browser tooling, and the e2e harness are not this defense's
// threat model (they don't get a free pass from an attacker's page the way a
// browser would), matching gorilla's own no-Origin allowance for /ws.
//
// This intentionally does not compare Origin to Host itself (that's
// upgrader's job for /ws, via gorilla's default CheckOrigin); it only asks
// "is Host one we trust", which is what stops DNS rebinding — a rebound
// request's Origin and Host both name the attacker's host, so an
// Origin-equals-Host check alone would let it through.
func hostAllowlist(allowed AllowedHosts, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" || allowed.Permits(r.Host) {
			next.ServeHTTP(w, r)
			return
		}
		log.Printf("rejected %s %s: Host %q is not in the allowed-hosts list (Origin %q) — if this is a reverse proxy or a wildcard -addr bind, it can't know its own reachable name automatically; set -allowed-hosts (or HTP_K8S_ALLOWED_HOSTS) to trust it", r.Method, r.URL.Path, r.Host, origin)
		http.Error(w, "host not allowed — see -allowed-hosts", http.StatusForbidden)
	})
}
