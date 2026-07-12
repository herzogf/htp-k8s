package kube

import (
	"context"
	"fmt"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ViewMode determines what a Tower represents in the scene (see CONTEXT.md).
type ViewMode string

const (
	// ViewModeNode renders one Tower per Node. Selected when the current
	// user is allowed to list Nodes cluster-wide.
	ViewModeNode ViewMode = "node"

	// ViewModeNamespace renders one Tower per Namespace/Project. The
	// graceful-degradation default (ADR-0002): selected whenever the user
	// cannot list Nodes, including on OpenShift where a user may only see
	// their own Projects.
	ViewModeNamespace ViewMode = "namespace"
)

// DetectViewMode runs a SelfSubjectAccessReview to decide the default View
// Mode for the current user: ViewModeNode if the user may list Nodes
// cluster-wide, otherwise ViewModeNamespace.
//
// Per ADR-0002 the probe must never hard-fail: a denied review, an API error,
// or an unreachable authorization endpoint all degrade to ViewModeNamespace
// (the least-privilege default) rather than surfacing an error. The returned
// error is informational only — the ViewMode is always usable — so callers can
// log why the probe fell back without having to treat it as fatal.
func DetectViewMode(ctx context.Context, client kubernetes.Interface) (ViewMode, error) {
	review := &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authorizationv1.ResourceAttributes{
				Verb:     "list",
				Group:    "", // core API group
				Resource: "nodes",
			},
		},
	}

	result, err := client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
	if err != nil {
		return ViewModeNamespace, fmt.Errorf("node-list permission probe failed: %w", err)
	}

	if result.Status.Allowed {
		return ViewModeNode, nil
	}
	return ViewModeNamespace, nil
}
