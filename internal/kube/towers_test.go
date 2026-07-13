package kube_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// node is a minimal Node object for the fake clientset.
func node(name string) *corev1.Node {
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

// namespace is a minimal Namespace object for the fake clientset.
func namespace(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

// project is a minimal OpenShift Project as an unstructured object for the
// dynamic fake client (project.openshift.io/v1, same name as its Namespace).
func project(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "project.openshift.io/v1",
		"kind":       "Project",
		"metadata":   map[string]any{"name": name},
	}}
}

// projectDynamicClient builds a dynamic fake client that knows the Project
// resource, seeded with the given Projects. Without the custom list-kind
// mapping the dynamic fake cannot serve a List of an out-of-tree resource.
func projectDynamicClient(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	gvr := schema.GroupVersionResource{Group: "project.openshift.io", Version: "v1", Resource: "projects"}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		scheme,
		map[schema.GroupVersionResource]string{gvr: "ProjectList"},
		objs...,
	)
}

// forbiddenNamespaceList makes the fake clientset deny listing Namespaces,
// mimicking an OpenShift-shaped cluster where a user may not list cluster
// Namespaces (but may list their own Projects).
func forbiddenNamespaceList() k8stesting.ReactionFunc {
	return func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "namespaces"}, "", errors.New("cannot list namespaces at the cluster scope"))
	}
}

// TestBuildTowers_NodeMode covers Tower generation in Node-mode against a fake
// clientset, including the deterministic grid-by-name position assignment.
func TestBuildTowers_NodeMode(t *testing.T) {
	// Deliberately unsorted input to prove the layout sorts by name.
	client := fake.NewSimpleClientset(
		node("worker-2"),
		node("control-plane"),
		node("worker-1"),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNode, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers node mode: %v", err)
	}

	// Three names → gridWidth ceil(sqrt(3)) = 2, so positions run
	// (0,0) (1,0) / (0,1), sorted by name.
	want := []scene.Tower{
		{Name: "control-plane", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "worker-1", Grid: scene.GridPosition{Col: 1, Row: 0}},
		{Name: "worker-2", Grid: scene.GridPosition{Col: 0, Row: 1}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("towers = %+v, want %+v", got, want)
	}
}

// TestBuildTowers_NamespaceMode covers Tower generation in Namespace-mode
// (vanilla Kubernetes shape: Namespaces are listable), including grid layout.
func TestBuildTowers_NamespaceMode(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("kube-system"),
		namespace("default"),
		namespace("app"),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers namespace mode: %v", err)
	}

	want := []scene.Tower{
		{Name: "app", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "default", Grid: scene.GridPosition{Col: 1, Row: 0}},
		{Name: "kube-system", Grid: scene.GridPosition{Col: 0, Row: 1}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("towers = %+v, want %+v", got, want)
	}
}

// TestBuildTowers_OpenShiftProjectFallback covers the ADR-0002 graceful path:
// a user who cannot list cluster Namespaces still gets Namespace-mode Towers,
// built from their OpenShift Projects, without a hard failure.
func TestBuildTowers_OpenShiftProjectFallback(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())

	dyn := projectDynamicClient(project("team-b"), project("team-a"))

	got, err := kube.BuildTowers(context.Background(), client, dyn, scene.ViewModeNamespace, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers openshift fallback: %v", err)
	}

	want := []scene.Tower{
		{Name: "team-a", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "team-b", Grid: scene.GridPosition{Col: 1, Row: 0}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("towers = %+v, want %+v", got, want)
	}
}

// TestBuildTowers_NamespaceMode_NoSourceDegrades proves that when neither
// Namespaces nor Projects can be listed, the scene degrades to an empty Tower
// set with an informational error rather than hard-failing (ADR-0002).
func TestBuildTowers_NamespaceMode_NoSourceDegrades(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())

	// nil dynamic client → no Project fallback available.
	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, kube.NamespaceFilter{})
	if err == nil {
		t.Fatal("expected an informational error when no namespace source is readable, got nil")
	}
	if len(got) != 0 {
		t.Fatalf("towers = %+v, want empty on degradation", got)
	}
	if got == nil {
		t.Fatal("towers slice is nil, want non-nil empty so the wire carries [] not null")
	}
}

// TestBuildTowers_Empty proves an empty cluster yields a non-nil empty Tower
// slice (so the wire carries [] rather than null).
func TestBuildTowers_Empty(t *testing.T) {
	client := fake.NewSimpleClientset()

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNode, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers empty: %v", err)
	}
	if got == nil {
		t.Fatal("towers slice is nil, want non-nil empty")
	}
	if len(got) != 0 {
		t.Fatalf("towers = %+v, want empty", got)
	}
}

// TestBuildTowers_GridIsNearSquare pins the grid-width rule (ceil(sqrt(n))) at
// a size where rows and columns both exceed one, so a regression in the layout
// (e.g. a single row, or an off-by-one width) is caught.
func TestBuildTowers_GridIsNearSquare(t *testing.T) {
	// 10 nodes named n0..n9 → gridWidth ceil(sqrt(10)) = 4.
	objs := make([]runtime.Object, 0, 10)
	names := []string{"n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"}
	for _, n := range names {
		objs = append(objs, node(n))
	}
	client := fake.NewSimpleClientset(objs...)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNode, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if len(got) != 10 {
		t.Fatalf("got %d towers, want 10", len(got))
	}

	const wantWidth = 4
	for i, tw := range got {
		wantCol, wantRow := i%wantWidth, i/wantWidth
		if tw.Grid.Col != wantCol || tw.Grid.Row != wantRow {
			t.Errorf("tower[%d] %q grid = (%d,%d), want (%d,%d)",
				i, tw.Name, tw.Grid.Col, tw.Grid.Row, wantCol, wantRow)
		}
		// Names are n0..n9, which sort lexicographically into that same
		// order, so tower i must be names[i].
		if tw.Name != names[i] {
			t.Errorf("tower[%d] name = %q, want %q", i, tw.Name, names[i])
		}
	}
}
