package main

import (
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
