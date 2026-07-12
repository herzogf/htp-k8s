// Package kube holds the htp-k8s Kubernetes/OpenShift client integration:
// connecting to the cluster via the current kubeconfig context (ADR-0001) and
// the startup permission probe that selects the default View Mode (ADR-0002).
package kube

import (
	"fmt"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// restConfig builds a *rest.Config from the current kubeconfig context,
// resolving it exactly as kubectl does (ADR-0001): it honours the KUBECONFIG
// environment variable (including a multi-file, colon-separated list), falls
// back to ~/.kube/config, and uses the file's current-context. This keeps
// htp-k8s's auth behaviour identical to the kubectl the user already trusts,
// rather than re-implementing credential resolution.
func restConfig() (*rest.Config, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules,
		&clientcmd.ConfigOverrides{},
	)

	cfg, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	return cfg, nil
}

// NewClientset connects to the cluster referenced by the current kubeconfig
// context (see restConfig) and returns a typed client for it.
func NewClientset() (kubernetes.Interface, error) {
	cfg, err := restConfig()
	if err != nil {
		return nil, err
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("build kubernetes clientset: %w", err)
	}
	return clientset, nil
}
