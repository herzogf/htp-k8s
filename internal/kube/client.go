// Package kube holds the htp-k8s Kubernetes/OpenShift client integration:
// connecting to the cluster via the current kubeconfig context (ADR-0001) and
// the startup permission probe that selects the default View Mode (ADR-0002).
package kube

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// containerKubeconfigPath is the default kubeconfig location inside the
// published container image (issue #113), matching the README's documented
// mount: `-v $HOME/.kube/config:/kube/config:ro`. See restConfig for when
// this is used.
const containerKubeconfigPath = "/kube/config"

// restConfig builds a *rest.Config from the current kubeconfig context,
// resolving it exactly as kubectl does (ADR-0001): it honours the KUBECONFIG
// environment variable (including a multi-file, colon-separated list), falls
// back to ~/.kube/config, and uses the file's current-context. This keeps
// htp-k8s's auth behaviour identical to the kubectl the user already trusts,
// rather than re-implementing credential resolution — and it is tried FIRST,
// unmodified, every time.
//
// If that finds nothing at all (clientcmd.IsEmptyConfig) and KUBECONFIG is
// unset, it retries once against containerKubeconfigPath as a last resort
// (issue #113). This can never regress a working native run: by construction
// it only fires when the normal resolution already came up empty, i.e. the
// process was about to fail anyway. An explicit KUBECONFIG is never
// second-guessed.
func restConfig() (*rest.Config, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules,
		&clientcmd.ConfigOverrides{},
	)

	cfg, err := clientConfig.ClientConfig()
	if err == nil {
		return cfg, nil
	}

	if !usesContainerKubeconfigDefault(os.Getenv("KUBECONFIG"), err) {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}

	// Retry against the container's documented default. ExplicitPath (not
	// Precedence): a missing ExplicitPath file is a load error naming the
	// path; a missing Precedence entry is silently skipped, which would
	// leave the original opaque "no configuration has been provided" error
	// with no hint that a kubeconfig belongs at containerKubeconfigPath.
	containerRules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: containerKubeconfigPath}
	containerConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		containerRules,
		&clientcmd.ConfigOverrides{},
	)

	cfg, err = containerConfig.ClientConfig()
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf(
				"load kubeconfig: no kubeconfig found at $KUBECONFIG, ~/.kube/config, or the container default %s — run with -v $HOME/.kube/config:%s:ro (or set KUBECONFIG to override the path): %w",
				containerKubeconfigPath, containerKubeconfigPath, err)
		}
		// issue #128: a file IS mounted at containerKubeconfigPath but the
		// container's fixed non-root user can't read it. This is the common
		// case in practice: clientcmd.WriteToFile — what kind, kubectl, and
		// most cloud-provider CLIs use — writes kubeconfigs mode 0600, and
		// the published image (ko's Chainguard-static base) runs as a fixed
		// uid that doesn't own the host's file. Distinct from the
		// fs.ErrNotExist branch above (a missing mount) — that diagnostic
		// would be actively misleading here, since a file IS mounted; the fix
		// is to make the container read it as the host user, not to mount it
		// somewhere else.
		//
		// Classified by re-opening containerKubeconfigPath directly rather
		// than inspecting err (see kubeconfigUnreadable): clientcmd's own
		// error can't be classified with errors.Is here — not because
		// apimachinery's error-aggregate type resists unwrapping (it doesn't;
		// aggregate.Is delegates to errors.Is on each contained error, see
		// k8s.io/apimachinery/pkg/util/errors' aggregate.Is) but because
		// clientcmd itself discards the typed error before the aggregate is
		// ever built: loader.go's LoadFromFile loop wraps a real read
		// failure with `fmt.Errorf(...: %v", ..., err)` — %v, not %w — which
		// flattens the *fs.PathError to plain text right there
		// (k8s.io/client-go@v0.36.2/tools/clientcmd/loader.go:236, verified
		// against the vendored source). By the time that text reaches the
		// aggregate, there is nothing left to traverse to.
		if kubeconfigUnreadable(containerKubeconfigPath) {
			return nil, fmt.Errorf(
				"load kubeconfig: found %s but cannot read it — a standard kind/kubectl-written kubeconfig is mode 0600 and the container runs as a fixed non-root user; add --user \"$(id -u):$(id -g)\" to docker run so the container reads it as you: %w",
				containerKubeconfigPath, err)
		}
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	return cfg, nil
}

// kubeconfigUnreadable reports whether path exists but the current process
// lacks permission to read it (the issue #128 failure mode), by opening it
// directly rather than trying to classify clientcmd's own error text (see the
// comment at this function's call site for why that doesn't work). Safe to
// do here specifically because this is only ever called with the
// compile-time-constant containerKubeconfigPath — a single, known file, not
// an unbounded or attacker-influenced path, and this is a diagnostic-only
// read with no TOCTOU-sensitive follow-up action.
func kubeconfigUnreadable(path string) bool {
	f, err := os.Open(path)
	if err == nil {
		f.Close()
		return false
	}
	return errors.Is(err, fs.ErrPermission)
}

// usesContainerKubeconfigDefault decides whether restConfig should retry
// against the container's fixed /kube/config default, given the current
// KUBECONFIG env var and the error from the normal resolution attempt
// (passed in, rather than read/recomputed here, so this decision is a pure,
// table-testable function). True only when KUBECONFIG is unset AND the
// normal resolution found nothing at all.
func usesContainerKubeconfigDefault(kubeconfigEnv string, resolveErr error) bool {
	return kubeconfigEnv == "" && clientcmd.IsEmptyConfig(resolveErr)
}

// NewClients connects to the cluster referenced by the current kubeconfig
// context (see restConfig) and returns both a typed client and a dynamic
// client built from the same config. The dynamic client is used to read
// resources that have no typed dependency in htp-k8s — notably OpenShift
// Projects (see BuildTowers) — so the app needs no OpenShift API library and
// degrades gracefully where those resources are absent (ADR-0002).
func NewClients() (kubernetes.Interface, dynamic.Interface, error) {
	cfg, err := restConfig()
	if err != nil {
		return nil, nil, err
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("build kubernetes clientset: %w", err)
	}

	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("build dynamic client: %w", err)
	}
	return clientset, dyn, nil
}
