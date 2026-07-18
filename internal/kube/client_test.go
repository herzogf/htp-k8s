package kube

import (
	"errors"
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
