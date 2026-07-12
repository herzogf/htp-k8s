package kube_test

import (
	"context"
	"errors"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// ssarReactor makes the fake clientset answer every SelfSubjectAccessReview
// create with the given allowed decision, mimicking the API server's
// authorizer without a real cluster.
func ssarReactor(allowed bool) k8stesting.ReactionFunc {
	return func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, &authorizationv1.SelfSubjectAccessReview{
			Status: authorizationv1.SubjectAccessReviewStatus{Allowed: allowed},
		}, nil
	}
}

func TestDetectViewMode(t *testing.T) {
	tests := []struct {
		name     string
		reactor  k8stesting.ReactionFunc
		wantMode scene.ViewMode
		wantErr  bool
	}{
		{
			name:     "can list nodes selects node mode",
			reactor:  ssarReactor(true),
			wantMode: scene.ViewModeNode,
		},
		{
			name:     "cannot list nodes falls back to namespace mode",
			reactor:  ssarReactor(false),
			wantMode: scene.ViewModeNamespace,
		},
		{
			name: "probe error degrades gracefully to namespace mode",
			reactor: func(k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, errors.New("authorization endpoint unreachable")
			},
			wantMode: scene.ViewModeNamespace,
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := fake.NewSimpleClientset()
			client.PrependReactor("create", "selfsubjectaccessreviews", tt.reactor)

			mode, err := kube.DetectViewMode(context.Background(), client)

			if mode != tt.wantMode {
				t.Errorf("mode = %q, want %q", mode, tt.wantMode)
			}
			if tt.wantErr && err == nil {
				t.Error("expected an informational error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}
