package kube

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
)

// EnsureReachable verifies the cluster's API server can actually be contacted,
// independent of the caller's RBAC, by probing the /version endpoint (normally
// readable without special permissions). It respects ctx, so callers can bound
// how long an unresponsive endpoint may stall startup — a black-holing server
// that silently drops packets fails once ctx expires rather than hanging.
//
// It returns an error only for a genuine transport-level failure — connection
// refused, DNS/TLS failure, or a context timeout — i.e. the server is
// unreachable. Any well-formed HTTP response from the API server, INCLUDING an
// auth error like 401/403, proves the server IS reachable and returns nil.
//
// The asymmetry with DetectViewMode is deliberate: an UNREACHABLE cluster is an
// operator setup error (wrong context, cluster down, bad kubeconfig) that
// should fail startup loudly, because there is nothing to visualize; a
// REACHABLE cluster where the user merely cannot list Nodes is an expected,
// supported RBAC posture that degrades gracefully to Namespace-mode per
// ADR-0002. Probing /version (not Nodes) and treating 401/403 as "reached"
// keeps that node-list permission decision entirely with DetectViewMode.
func EnsureReachable(ctx context.Context, client kubernetes.Interface) error {
	err := client.Discovery().RESTClient().Get().AbsPath("/version").Do(ctx).Error()
	return classifyReachability(err)
}

// classifyReachability maps the result of the /version probe to a startup
// decision. It classifies by error shape, not string matching: a nil error, or
// an apierrors.APIStatus error (the server answered, even with a 401/403),
// means reachable; any other error is a transport failure and means
// unreachable. The transport cause is wrapped, not swallowed, so the operator
// sees which endpoint failed and why.
func classifyReachability(err error) error {
	if err == nil {
		return nil
	}

	var apiStatus apierrors.APIStatus
	if errors.As(err, &apiStatus) {
		return nil
	}

	return fmt.Errorf("kubernetes API server unreachable (check that the cluster is running and your kubeconfig current-context is correct): %w", err)
}
