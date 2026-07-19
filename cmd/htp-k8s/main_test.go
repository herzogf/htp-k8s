package main

import (
	"log"
	"strings"
	"testing"
)

// noEnv is an env lookup that returns nothing, so a test exercises flag/default
// behaviour without inheriting the real process environment.
func noEnv(string) string { return "" }

// envMap returns an env lookup backed by a fixed map, for tests that drive the
// environment fallbacks hermetically.
func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestParseFlags_DefaultsWhenNoFlagOrEnv(t *testing.T) {
	opts, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.addr != defaultAddr {
		t.Fatalf("addr = %q, want %q", opts.addr, defaultAddr)
	}
	if opts.filter.Active() {
		t.Fatal("filter is active with no flag or env, want the no-filter default (nothing hidden)")
	}
}

// TestParseFlags_DefaultAddrIsLoopback pins the literal default (issue #127)
// against the symbolic defaultAddr check above: htp-k8s has no
// authentication layer anywhere in internal/server, so the default must be
// loopback-only, not just "whatever defaultAddr happens to be" — a future
// edit that silently widened defaultAddr back to all-interfaces would still
// pass the test above (it compares against the same var) but must fail this
// one.
func TestParseFlags_DefaultAddrIsLoopback(t *testing.T) {
	opts, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.addr != "127.0.0.1:8080" {
		t.Fatalf("addr = %q, want the loopback-only default %q", opts.addr, "127.0.0.1:8080")
	}
	if !isLoopbackAddr(opts.addr) {
		t.Fatalf("default addr %q is not loopback per isLoopbackAddr", opts.addr)
	}
}

func TestParseFlags_EnvOverridesDefault(t *testing.T) {
	opts, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_ADDR": ":9090"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.addr != ":9090" {
		t.Fatalf("addr = %q, want %q", opts.addr, ":9090")
	}
}

func TestParseFlags_FlagOverridesEnv(t *testing.T) {
	opts, err := parseFlags([]string{"-addr", ":7070"}, envMap(map[string]string{"HTP_K8S_ADDR": ":9090"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.addr != ":7070" {
		t.Fatalf("addr = %q, want %q", opts.addr, ":7070")
	}
}

func TestParseFlags_InvalidFlagReturnsError(t *testing.T) {
	if _, err := parseFlags([]string{"-not-a-flag"}, noEnv); err == nil {
		t.Fatal("expected error for unknown flag, got nil")
	}
}

// TestParseFlags_NameFilterPreset proves the default-mode name-pattern filter
// can be preset from the CLI and is active.
func TestParseFlags_NameFilterPreset(t *testing.T) {
	opts, err := parseFlags([]string{"-namespace-filter", "openshift-*"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.filter.Active() {
		t.Fatal("name filter preset did not produce an active filter")
	}
}

// TestParseFlags_LabelFilterPreset proves the advanced-mode label selector can
// be preset from the CLI and is active.
func TestParseFlags_LabelFilterPreset(t *testing.T) {
	opts, err := parseFlags([]string{"-namespace-label-filter", "team=platform"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.filter.Active() {
		t.Fatal("label filter preset did not produce an active filter")
	}
}

// TestParseFlags_FilterFromEnv proves the name filter can be preset via the
// environment fallback, mirroring the addr precedence.
func TestParseFlags_FilterFromEnv(t *testing.T) {
	opts, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_NAMESPACE_FILTER": "kube-*"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.filter.Active() {
		t.Fatal("HTP_K8S_NAMESPACE_FILTER did not produce an active filter")
	}
}

// TestParseFlags_BothFilterModesRejected proves setting both filter modes at
// once fails at startup — there is one filter, in one mode.
func TestParseFlags_BothFilterModesRejected(t *testing.T) {
	_, err := parseFlags([]string{"-namespace-filter", "app-*", "-namespace-label-filter", "team=platform"}, noEnv)
	if err == nil {
		t.Fatal("expected an error when both filter modes are set, got nil")
	}
}

// TestParseFlags_InvalidLabelSelectorRejected proves a malformed label selector
// fails at startup rather than silently matching nothing.
func TestParseFlags_InvalidLabelSelectorRejected(t *testing.T) {
	if _, err := parseFlags([]string{"-namespace-label-filter", "=bad"}, noEnv); err == nil {
		t.Fatal("expected an error for a malformed label selector, got nil")
	}
}

// TestParseFlags_InvalidNamePatternRejected proves a malformed name pattern
// fails at startup.
func TestParseFlags_InvalidNamePatternRejected(t *testing.T) {
	if _, err := parseFlags([]string{"-namespace-filter", "openshift-[a"}, noEnv); err == nil {
		t.Fatal("expected an error for a malformed name pattern, got nil")
	}
}

// TestParseFlags_DemoSeedDefaultsToRandomWhenUnset proves that with neither
// the flag nor the env var set, parseFlags still resolves a seed (rather than
// the zero value) — Demo Mode's Canyon tour (ADR-0010) always has something to
// seed from, even when an operator never sets one explicitly.
func TestParseFlags_DemoSeedDefaultsToRandomWhenUnset(t *testing.T) {
	opts, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed == 0 {
		t.Fatal("demoSeed = 0 with no flag or env, want a resolved (non-zero) random seed")
	}
}

// TestParseFlags_DemoSeedFlagIsHonored proves an explicit -demo-seed is used
// verbatim, not overridden by the random fallback — including the seed 0,
// which is a legitimate explicit seed distinct from "unset".
func TestParseFlags_DemoSeedFlagIsHonored(t *testing.T) {
	opts, err := parseFlags([]string{"-demo-seed", "0"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed != 0 {
		t.Fatalf("demoSeed = %d, want the explicit 0", opts.demoSeed)
	}

	opts, err = parseFlags([]string{"-demo-seed", "12345"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed != 12345 {
		t.Fatalf("demoSeed = %d, want 12345", opts.demoSeed)
	}
}

// TestParseFlags_DemoSeedFromEnv proves HTP_K8S_DEMO_SEED is honored,
// mirroring the addr/filter env precedent.
func TestParseFlags_DemoSeedFromEnv(t *testing.T) {
	opts, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_DEMO_SEED": "777"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed != 777 {
		t.Fatalf("demoSeed = %d, want 777", opts.demoSeed)
	}
}

// TestParseFlags_DemoSeedFlagOverridesEnv proves flag > env precedence for
// -demo-seed/HTP_K8S_DEMO_SEED.
func TestParseFlags_DemoSeedFlagOverridesEnv(t *testing.T) {
	opts, err := parseFlags([]string{"-demo-seed", "5"}, envMap(map[string]string{"HTP_K8S_DEMO_SEED": "9"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed != 5 {
		t.Fatalf("demoSeed = %d, want 5", opts.demoSeed)
	}
}

// TestParseFlags_InvalidDemoSeedRejected proves a non-integer -demo-seed fails
// at startup rather than silently falling back to a random seed.
func TestParseFlags_InvalidDemoSeedRejected(t *testing.T) {
	if _, err := parseFlags([]string{"-demo-seed", "not-a-number"}, noEnv); err == nil {
		t.Fatal("expected an error for a non-integer demo seed, got nil")
	}
}

// TestParseFlags_DemoDefaultsFalse proves Demo Mode does not auto-start
// unless requested.
func TestParseFlags_DemoDefaultsFalse(t *testing.T) {
	opts, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoAutostart {
		t.Fatal("demoAutostart = true with no flag or env, want false")
	}
}

// TestParseFlags_DemoFlagEnablesAutostart proves the -demo flag enables
// autostart.
func TestParseFlags_DemoFlagEnablesAutostart(t *testing.T) {
	opts, err := parseFlags([]string{"-demo"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.demoAutostart {
		t.Fatal("demoAutostart = false with -demo set, want true")
	}
}

// TestParseFlags_DemoFromEnv proves HTP_K8S_DEMO is honored, mirroring the
// addr/filter env precedent.
func TestParseFlags_DemoFromEnv(t *testing.T) {
	opts, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_DEMO": "true"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.demoAutostart {
		t.Fatal("demoAutostart = false with HTP_K8S_DEMO=true, want true")
	}
}

// TestParseFlags_DemoFlagOverridesEnv proves flag > env precedence for
// -demo/HTP_K8S_DEMO, and that -demo=false can override an env default of true.
func TestParseFlags_DemoFlagOverridesEnv(t *testing.T) {
	opts, err := parseFlags([]string{"-demo=false"}, envMap(map[string]string{"HTP_K8S_DEMO": "true"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoAutostart {
		t.Fatal("demoAutostart = true with -demo=false overriding HTP_K8S_DEMO=true, want false")
	}
}

// TestParseFlags_InvalidDemoEnvRejected proves a malformed HTP_K8S_DEMO value
// fails at startup rather than silently defaulting.
func TestParseFlags_InvalidDemoEnvRejected(t *testing.T) {
	if _, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_DEMO": "not-a-bool"})); err == nil {
		t.Fatal("expected an error for a malformed HTP_K8S_DEMO value, got nil")
	}
}

// TestParseFlags_DemoSeedAndAutostartAreOrthogonal proves the two flags can be
// set independently in either combination — a seed without autostart, and
// autostart without an explicit seed.
func TestParseFlags_DemoSeedAndAutostartAreOrthogonal(t *testing.T) {
	opts, err := parseFlags([]string{"-demo-seed", "42"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.demoSeed != 42 || opts.demoAutostart {
		t.Fatalf("opts = %+v, want seed 42 with autostart false", opts)
	}

	opts, err = parseFlags([]string{"-demo"}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if !opts.demoAutostart || opts.demoSeed == 0 {
		t.Fatalf("opts = %+v, want autostart true with a resolved (non-zero) random seed", opts)
	}
}

// TestParseFlags_AllowedHostsDefaultsToNil proves no flag or env leaves
// allowedHosts empty — server.NewAllowedHosts still trusts loopback and the
// addr host on its own, so an operator on the defaults needs nothing extra.
func TestParseFlags_AllowedHostsDefaultsToNil(t *testing.T) {
	opts, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if opts.allowedHosts != nil {
		t.Fatalf("allowedHosts = %v, want nil with no flag or env", opts.allowedHosts)
	}
}

// TestParseFlags_AllowedHostsFlag proves -allowed-hosts splits on commas and
// trims whitespace, dropping empty entries.
func TestParseFlags_AllowedHostsFlag(t *testing.T) {
	opts, err := parseFlags([]string{"-allowed-hosts", "k8s.example.com, proxy.internal:8443,, other.example.com "}, noEnv)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	want := []string{"k8s.example.com", "proxy.internal:8443", "other.example.com"}
	if len(opts.allowedHosts) != len(want) {
		t.Fatalf("allowedHosts = %v, want %v", opts.allowedHosts, want)
	}
	for i := range want {
		if opts.allowedHosts[i] != want[i] {
			t.Fatalf("allowedHosts = %v, want %v", opts.allowedHosts, want)
		}
	}
}

// TestParseFlags_AllowedHostsFromEnv proves HTP_K8S_ALLOWED_HOSTS is honored,
// mirroring the addr/filter env precedent.
func TestParseFlags_AllowedHostsFromEnv(t *testing.T) {
	opts, err := parseFlags(nil, envMap(map[string]string{"HTP_K8S_ALLOWED_HOSTS": "k8s.example.com"}))
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if len(opts.allowedHosts) != 1 || opts.allowedHosts[0] != "k8s.example.com" {
		t.Fatalf("allowedHosts = %v, want [k8s.example.com]", opts.allowedHosts)
	}
}

// TestParseFlags_AllowedHostsFlagOverridesEnv proves flag > env precedence
// for -allowed-hosts/HTP_K8S_ALLOWED_HOSTS.
func TestParseFlags_AllowedHostsFlagOverridesEnv(t *testing.T) {
	opts, err := parseFlags(
		[]string{"-allowed-hosts", "flag.example.com"},
		envMap(map[string]string{"HTP_K8S_ALLOWED_HOSTS": "env.example.com"}),
	)
	if err != nil {
		t.Fatalf("parseFlags returned error: %v", err)
	}
	if len(opts.allowedHosts) != 1 || opts.allowedHosts[0] != "flag.example.com" {
		t.Fatalf("allowedHosts = %v, want [flag.example.com]", opts.allowedHosts)
	}
}

func TestVersionRequested(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"no args", nil, false},
		{"version subcommand", []string{"version"}, true},
		{"-version flag", []string{"-version"}, true},
		{"--version flag", []string{"--version"}, true},
		{"addr flag only", []string{"-addr", ":9090"}, false},
		{"version not first arg is still a flag", []string{"-addr", ":9090", "--version"}, true},
		{"version as flag value is not a subcommand", []string{"-addr", "version"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := versionRequested(tc.args); got != tc.want {
				t.Fatalf("versionRequested(%q) = %v, want %v", tc.args, got, tc.want)
			}
		})
	}
}

func TestVersionString_IncludesBuildMetadata(t *testing.T) {
	// versionString must surface all three injected build vars so the printed
	// line is a complete build fingerprint.
	s := versionString()
	for _, want := range []string{version, commit, date} {
		if !strings.Contains(s, want) {
			t.Fatalf("versionString() = %q, missing %q", s, want)
		}
	}
}

// TestIsLoopbackAddr covers the cases that matter for issue #127's startup
// log message: the two loopback spellings a real deployment might use, the
// two "all interfaces" spellings, a non-loopback IP, and the malformed/
// unresolvable-hostname inputs that must conservatively read as "not
// loopback" per isLoopbackAddr's doc comment.
func TestIsLoopbackAddr(t *testing.T) {
	cases := []struct {
		name string
		addr string
		want bool
	}{
		{"loopback IPv4 default", "127.0.0.1:8080", true},
		{"loopback IPv4 other port", "127.0.0.1:9090", true},
		{"loopback IPv6", "[::1]:8080", true},
		{"localhost hostname", "localhost:8080", true},
		{"bare port form (all interfaces)", ":8080", false},
		{"explicit 0.0.0.0 (all interfaces)", "0.0.0.0:8080", false},
		{"explicit IPv6 all interfaces", "[::]:8080", false},
		{"non-loopback IPv4", "192.168.1.5:8080", false},
		{"arbitrary hostname (unresolved here, must not claim loopback)", "example.com:8080", false},
		{"malformed: no port", "127.0.0.1", false},
		{"empty string", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isLoopbackAddr(tc.addr); got != tc.want {
				t.Fatalf("isLoopbackAddr(%q) = %v, want %v", tc.addr, got, tc.want)
			}
		})
	}
}

// TestLogListenAddr_LoopbackMentionsBothOptOutForms proves the loopback log
// message names BOTH the flag and the env var an operator might reach for to
// widen exposure — an operator who only knows one form of htp-k8s's
// flag/env convention must still find the other in this line. It also pins
// the literal "bound to loopback only" text: test/e2e/container-kubeconfig/
// run.sh's test 5a greps the real container's log for that exact string to
// prove the SHIPPED IMAGE's own default is fail-closed, and nothing else
// fast-fails a wording change to it — without this assertion, a copy-edit
// here would only surface as a confusing e2e failure ("IMAGE's own default
// may not be loopback-only any more") instead of a fast, on-point one right
// here.
func TestLogListenAddr_LoopbackMentionsBothOptOutForms(t *testing.T) {
	out := captureLog(t, func() { logListenAddr("127.0.0.1:8080") })
	for _, want := range []string{"-addr", "HTP_K8S_ADDR", "127.0.0.1:8080", "bound to loopback only"} {
		if !strings.Contains(out, want) {
			t.Fatalf("logListenAddr(loopback) output = %q, missing %q", out, want)
		}
	}
	if strings.Contains(out, "WARNING") {
		t.Fatalf("logListenAddr(loopback) output = %q, should not warn for a safe default", out)
	}
}

// TestLogListenAddr_NonLoopbackWarnsLoudly proves a non-loopback bind gets an
// explicit, loud warning naming the actual risk (no auth, read access to the
// operator's cluster) rather than a message easy to mistake for routine
// informational output.
func TestLogListenAddr_NonLoopbackWarnsLoudly(t *testing.T) {
	out := captureLog(t, func() { logListenAddr(":8080") })
	for _, want := range []string{"WARNING", ":8080"} {
		if !strings.Contains(out, want) {
			t.Fatalf("logListenAddr(:8080) output = %q, missing %q", out, want)
		}
	}
}

// captureLog redirects the standard "log" package's output for the duration
// of fn and returns everything it wrote, restoring the previous output
// afterward regardless of how fn returns.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	prevOutput := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(prevOutput)
		log.SetFlags(prevFlags)
	}()
	fn()
	return buf.String()
}
