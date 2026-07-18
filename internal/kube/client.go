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

// containerUID is ko's/Chainguard's fixed non-root uid for the published
// image (ADR-0005; see .ko.yaml and `docker inspect --format '{{.Config.User}}'`).
// It is the one signal restConfig uses to recognise "this is our published
// container", deliberately NOT anything HOME-derived — see restConfig's doc
// comment for why.
const containerUID = 65532

// containerKubeconfigPath is the default kubeconfig location inside the
// published container image (issue #113), matching the README's documented
// mount: `-v $HOME/.kube/config:/kube/config:ro`. See restConfig for when
// this is actually used.
const containerKubeconfigPath = "/kube/config"

// restConfig builds a *rest.Config from the current kubeconfig context,
// resolving it exactly as kubectl does (ADR-0001): it honours the KUBECONFIG
// environment variable (including a multi-file, colon-separated list), falls
// back to ~/.kube/config, and uses the file's current-context. This keeps
// htp-k8s's auth behaviour identical to the kubectl the user already trusts,
// rather than re-implementing credential resolution — and it is tried FIRST,
// unmodified, every time: nothing below ever runs unless this default
// resolution already found nothing.
//
// Container fallback (issue #113): naively, the published image's fixed
// non-root uid (ADR-0005 distroless base) has no HOME, so client-go's
// ~/.kube/config default would have nothing to resolve against. In practice
// it's subtler: the Chainguard static base DOES define uid 65532 in its
// image /etc/passwd (as "nonroot", home "/home/nonroot"), so container
// runtimes (runc, via dockerd/containerd) resolve HOME=/home/nonroot at
// startup — client-go's default doesn't fail outright, it just quietly
// resolves to /home/nonroot/.kube/config. Mounting a kubeconfig there
// happens to work today, but documenting that exact path would tie the
// README to an internal detail of a third-party base image pulled by a
// floating `:latest` tag (see .ko.yaml) — it could change on any image
// update with no build-time signal. So htp-k8s pins its OWN documented
// mount point (containerKubeconfigPath) rather than depend on Chainguard's.
//
// This fallback only engages when ALL of the following hold, so it can never
// touch an already-working native resolution:
//   - KUBECONFIG is unset (an explicit KUBECONFIG, container or not, is
//     never second-guessed);
//   - the default resolution above found nothing at all (clientcmd.IsEmptyConfig);
//   - the process uid is containerUID — the one thing that actually
//     identifies "this is the published image" without guessing about HOME.
//     A native run essentially never has this uid; the rare deployment that
//     deliberately does (e.g. a CI job impersonating it) only reaches this
//     branch if ITS default resolution also came up empty, so there is
//     nothing working to override.
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

	if !usesContainerKubeconfigDefault(os.Getenv("KUBECONFIG"), os.Getuid(), err) {
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
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	return cfg, nil
}

// usesContainerKubeconfigDefault decides whether restConfig should retry
// against the container's fixed /kube/config default, given the current
// KUBECONFIG env var, the process uid, and the error from the normal
// resolution attempt (passed in, rather than read/recomputed here, so this
// decision is a pure, table-testable function). See restConfig's doc comment
// for the full reasoning; in short: only when KUBECONFIG is unset, the uid is
// containerUID, and the normal resolution found nothing at all does this
// report true.
func usesContainerKubeconfigDefault(kubeconfigEnv string, uid int, resolveErr error) bool {
	return kubeconfigEnv == "" && uid == containerUID && clientcmd.IsEmptyConfig(resolveErr)
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
