package main

import (
	"strings"
	"testing"
)

func TestResolveAddr_DefaultsWhenNoFlagOrEnv(t *testing.T) {
	addr, err := resolveAddr(nil, "")
	if err != nil {
		t.Fatalf("resolveAddr returned error: %v", err)
	}
	if addr != defaultAddr {
		t.Fatalf("addr = %q, want %q", addr, defaultAddr)
	}
}

func TestResolveAddr_EnvOverridesDefault(t *testing.T) {
	addr, err := resolveAddr(nil, ":9090")
	if err != nil {
		t.Fatalf("resolveAddr returned error: %v", err)
	}
	if addr != ":9090" {
		t.Fatalf("addr = %q, want %q", addr, ":9090")
	}
}

func TestResolveAddr_FlagOverridesEnv(t *testing.T) {
	addr, err := resolveAddr([]string{"-addr", ":7070"}, ":9090")
	if err != nil {
		t.Fatalf("resolveAddr returned error: %v", err)
	}
	if addr != ":7070" {
		t.Fatalf("addr = %q, want %q", addr, ":7070")
	}
}

func TestResolveAddr_InvalidFlagReturnsError(t *testing.T) {
	if _, err := resolveAddr([]string{"-not-a-flag"}, ""); err == nil {
		t.Fatal("expected error for unknown flag, got nil")
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
