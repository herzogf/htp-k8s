package kube

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"k8s.io/client-go/tools/clientcmd"
)

// TestUsesContainerKubeconfigDefault covers the decision restConfig makes
// about whether to retry against the container's /kube/config default. It is
// tested as a pure function (kubeconfigEnv, resolveErr) -> bool: true only
// when KUBECONFIG is unset AND the normal resolution found nothing at all —
// so it can never fire while a working native resolution exists (the normal
// attempt already ran, unmodified, and failed empty before this is even
// consulted).
func TestUsesContainerKubeconfigDefault(t *testing.T) {
	emptyConfigErr := clientcmd.ErrEmptyConfig
	otherErr := errors.New("some other resolution failure")

	tests := []struct {
		name          string
		kubeconfigEnv string
		resolveErr    error
		want          bool
	}{
		{
			name:          "nothing found, no KUBECONFIG: retry",
			kubeconfigEnv: "",
			resolveErr:    emptyConfigErr,
			want:          true,
		},
		{
			name:          "KUBECONFIG set: an explicit KUBECONFIG is never second-guessed",
			kubeconfigEnv: "/somewhere/config",
			resolveErr:    emptyConfigErr,
			want:          false,
		},
		{
			name:          "the failure isn't an empty-config failure: don't mask a different error",
			kubeconfigEnv: "",
			resolveErr:    otherErr,
			want:          false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := usesContainerKubeconfigDefault(tt.kubeconfigEnv, tt.resolveErr)
			if got != tt.want {
				t.Errorf("usesContainerKubeconfigDefault(%q, %v) = %v, want %v",
					tt.kubeconfigEnv, tt.resolveErr, got, tt.want)
			}
		})
	}
}

// TestRestConfig_ExplicitKUBECONFIG_NeverRedirected covers the compatibility
// constraint end-to-end: with KUBECONFIG explicitly set to a nonexistent
// file, restConfig must fail on THAT path — never silently redirect to the
// container default — regardless of what uid the test happens to run as.
func TestRestConfig_ExplicitKUBECONFIG_NeverRedirected(t *testing.T) {
	t.Setenv("KUBECONFIG", "/definitely/not/a/real/kubeconfig")

	_, err := restConfig()
	if err == nil {
		t.Fatal("restConfig() = nil error, want an error (bogus KUBECONFIG path)")
	}
	if strings.Contains(err.Error(), containerKubeconfigPath) {
		t.Errorf("an explicit KUBECONFIG was redirected to the container default: %v", err)
	}
}

// TestKubeconfigUnreadable covers the issue #128 permission classifier as a
// pure function over a real file, exercising all three outcomes a mounted
// containerKubeconfigPath can be in: readable, present-but-permission-denied,
// and altogether missing (which must NOT be classified as a permission
// problem — that's the separate fs.ErrNotExist diagnostic in restConfig).
//
// Skipped when running as root: a root process can read a mode-000 file
// regardless of permission bits, which would make the "unreadable" case
// false — that's an environment property, not a bug in the function.
func TestKubeconfigUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: permission bits don't block root, so this test can't exercise a real permission-denied read")
	}

	dir := t.TempDir()

	readable := filepath.Join(dir, "readable")
	if err := os.WriteFile(readable, []byte("kind: Config"), 0o644); err != nil {
		t.Fatalf("WriteFile(readable): %v", err)
	}

	unreadable := filepath.Join(dir, "unreadable")
	if err := os.WriteFile(unreadable, []byte("kind: Config"), 0o000); err != nil {
		t.Fatalf("WriteFile(unreadable): %v", err)
	}

	missing := filepath.Join(dir, "does-not-exist")

	tests := []struct {
		name string
		path string
		want bool
	}{
		{"readable file: not a permission problem", readable, false},
		{"0000-mode file: a permission problem", unreadable, true},
		{"missing file: not a permission problem (that's the not-exist case)", missing, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := kubeconfigUnreadable(tt.path)
			if got != tt.want {
				t.Errorf("kubeconfigUnreadable(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}
