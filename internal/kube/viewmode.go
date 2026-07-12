package kube

import (
	"context"
	"fmt"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// DetectViewMode runs a SelfSubjectAccessReview to decide the default View
// Mode for the current user: scene.ViewModeNode if the user may list Nodes
// cluster-wide, otherwise scene.ViewModeNamespace. The ViewMode type and its
// values live in the scene package because they are part of the frontend wire
// contract (see scene.SceneState); this package only decides which one applies.
//
// Per ADR-0002 the probe must never hard-fail: a denied review, an API error,
// or an unreachable authorization endpoint all degrade to ViewModeNamespace
// (the least-privilege default) rather than surfacing an error. The returned
// error is informational only — the ViewMode is always usable — so callers can
// log why the probe fell back without having to treat it as fatal.
func DetectViewMode(ctx context.Context, client kubernetes.Interface) (scene.ViewMode, error) {
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
		return scene.ViewModeNamespace, fmt.Errorf("node-list permission probe failed: %w", err)
	}

	if result.Status.Allowed {
		return scene.ViewModeNode, nil
	}
	return scene.ViewModeNamespace, nil
}
