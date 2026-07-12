package main

import "testing"

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
