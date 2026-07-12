package kube

import (
	"context"
	"errors"
	"net/url"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// TestClassifyReachability covers the reachable/unreachable decision that
// drives whether startup proceeds or fails. It exercises the pure classifier
// directly (the network call in EnsureReachable is proven against a real and a
// bogus endpoint by the integration test).
func TestClassifyReachability(t *testing.T) {
	forbidden := apierrors.NewForbidden(
		schema.GroupResource{Resource: "version"}, "", errors.New("nope"),
	)

	tests := []struct {
		name          string
		err           error
		wantReachable bool
	}{
		{
			name:          "server answers ok is reachable",
			err:           nil,
			wantReachable: true,
		},
		{
			name:          "forbidden status means the server was reached",
			err:           forbidden,
			wantReachable: true,
		},
		{
			name:          "unauthorized status means the server was reached",
			err:           apierrors.NewUnauthorized("no creds"),
			wantReachable: true,
		},
		{
			name: "connection refused is unreachable",
			err: &url.Error{
				Op:  "Get",
				URL: "https://192.0.2.1:6443/version",
				Err: errors.New("dial tcp 192.0.2.1:6443: connect: connection refused"),
			},
			wantReachable: false,
		},
		{
			name:          "context deadline is unreachable",
			err:           context.DeadlineExceeded,
			wantReachable: false,
		},
		{
			name:          "bare dns error is unreachable",
			err:           errors.New("dial tcp: lookup bogus-host: no such host"),
			wantReachable: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyReachability(tt.err)
			if tt.wantReachable {
				if got != nil {
					t.Errorf("classifyReachability = %v, want nil (reachable)", got)
				}
				return
			}
			if got == nil {
				t.Fatal("classifyReachability = nil, want an unreachable error")
			}
			// The underlying transport error must be wrapped, not swallowed,
			// so operators see which endpoint failed.
			if !errors.Is(got, tt.err) {
				t.Errorf("unreachable error %v does not wrap the transport cause %v", got, tt.err)
			}
		})
	}
}
