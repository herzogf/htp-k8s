package kube

import (
	"errors"
	"strings"
	"testing"

	"k8s.io/client-go/tools/clientcmd"
)

// TestUsesContainerKubeconfigDefault covers the decision restConfig makes
// about whether to retry against the container's /kube/config default. It is
// tested as a pure function (kubeconfigEnv, uid, resolveErr) -> bool rather
// than end-to-end through restConfig(), because the real container signal —
// the process uid — can't be faked from an unprivileged test process; the
// container path is instead exercised for real in a built image (see the PR
// description for the docker-run verification).
func TestUsesContainerKubeconfigDefault(t *testing.T) {
	emptyConfigErr := clientcmd.ErrEmptyConfig
	otherErr := errors.New("some other resolution failure")

	tests := []struct {
		name          string
		kubeconfigEnv string
		uid           int
		resolveErr    error
		want          bool
	}{
		{
			name:          "container uid, nothing found, no KUBECONFIG: retry",
			kubeconfigEnv: "",
			uid:           containerUID,
			resolveErr:    emptyConfigErr,
			want:          true,
		},
		{
			name:          "non-container uid: never retry, even if nothing found",
			kubeconfigEnv: "",
			uid:           1000,
			resolveErr:    emptyConfigErr,
			want:          false,
		},
		{
			name:          "container uid but KUBECONFIG set: an explicit KUBECONFIG is never second-guessed",
			kubeconfigEnv: "/somewhere/config",
			uid:           containerUID,
			resolveErr:    emptyConfigErr,
			want:          false,
		},
		{
			name:          "container uid but the failure isn't an empty-config failure: don't mask a different error",
			kubeconfigEnv: "",
			uid:           containerUID,
			resolveErr:    otherErr,
			want:          false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := usesContainerKubeconfigDefault(tt.kubeconfigEnv, tt.uid, tt.resolveErr)
			if got != tt.want {
				t.Errorf("usesContainerKubeconfigDefault(%q, %d, %v) = %v, want %v",
					tt.kubeconfigEnv, tt.uid, tt.resolveErr, got, tt.want)
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
