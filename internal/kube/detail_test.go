package kube_test

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// readyNode builds a Ready Node with capacity, node-info, and labels populated,
// for the Node-mode tower-detail tests.
func readyNode(name string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: map[string]string{"kubernetes.io/hostname": name, "role": "worker"},
		},
		Status: corev1.NodeStatus{
			Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue},
			},
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("8"),
				corev1.ResourceMemory: resource.MustParse("32Gi"),
				corev1.ResourcePods:   resource.MustParse("110"),
			},
			NodeInfo: corev1.NodeSystemInfo{
				KubeletVersion:  "v1.34.0",
				OperatingSystem: "linux",
				Architecture:    "amd64",
			},
		},
	}
}

func TestBuildTowerDetail_Node(t *testing.T) {
	client := fake.NewSimpleClientset(
		readyNode("node-a"),
		pod("default", "p1", "node-a", corev1.PodRunning),
		pod("default", "p2", "node-a", corev1.PodRunning),
		pod("default", "p3", "node-b", corev1.PodRunning),
	)

	detail, err := kube.BuildTowerDetail(context.Background(), client, nil, scene.ViewModeNode, "node-a")
	if err != nil {
		t.Fatalf("BuildTowerDetail: %v", err)
	}

	if detail.Name != "node-a" || detail.Kind != scene.TowerKindNode {
		t.Fatalf("detail identity = %q/%q, want node-a/node", detail.Name, detail.Kind)
	}
	if detail.Namespace != nil {
		t.Error("Node-mode detail carries a Namespace summary, want nil")
	}
	n := detail.Node
	if n == nil {
		t.Fatal("Node summary is nil")
	}
	if !n.Ready || n.Status != "Ready" {
		t.Errorf("readiness = %v/%q, want true/Ready", n.Ready, n.Status)
	}
	if n.KubeletVersion != "v1.34.0" || n.OS != "linux" || n.Architecture != "amd64" {
		t.Errorf("node-info = %q/%q/%q", n.KubeletVersion, n.OS, n.Architecture)
	}
	if n.CPU != "8" || n.Memory != "32Gi" || n.Pods != "110" {
		t.Errorf("capacity = %q/%q/%q, want 8/32Gi/110", n.CPU, n.Memory, n.Pods)
	}
	if n.Labels["role"] != "worker" {
		t.Errorf("labels = %v, want role=worker", n.Labels)
	}
	if n.PodCount != 2 {
		t.Errorf("PodCount = %d, want 2 (only pods on node-a)", n.PodCount)
	}
}

// TestBuildTowerDetail_NodeForbidden_Degrades asserts the ADR-0002 posture: a
// Node the caller may not Get still yields a Name+Kind detail (summary nil) plus
// an informational error, not a hard failure.
func TestBuildTowerDetail_NodeForbidden_Degrades(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("get", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "nodes"}, "node-a", errors.New("nope"))
	})

	detail, err := kube.BuildTowerDetail(context.Background(), client, nil, scene.ViewModeNode, "node-a")
	if err == nil {
		t.Fatal("want an informational error when the Node can't be read")
	}
	if detail.Name != "node-a" || detail.Kind != scene.TowerKindNode {
		t.Errorf("degraded detail identity = %q/%q, want node-a/node", detail.Name, detail.Kind)
	}
	if detail.Node != nil {
		t.Error("degraded detail carries a Node summary, want nil")
	}
}

func TestBuildTowerDetail_Namespace(t *testing.T) {
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: "team-a", Labels: map[string]string{"team": "a"}},
		Status:     corev1.NamespaceStatus{Phase: corev1.NamespaceActive},
	}
	client := fake.NewSimpleClientset(
		ns,
		pod("team-a", "p1", "node-a", corev1.PodRunning),
		pod("team-a", "p2", "node-a", corev1.PodRunning),
		pod("team-b", "p3", "node-a", corev1.PodRunning),
	)

	detail, err := kube.BuildTowerDetail(context.Background(), client, nil, scene.ViewModeNamespace, "team-a")
	if err != nil {
		t.Fatalf("BuildTowerDetail: %v", err)
	}
	if detail.Kind != scene.TowerKindNamespace || detail.Node != nil {
		t.Fatalf("kind/node = %q/%v, want namespace/nil", detail.Kind, detail.Node)
	}
	s := detail.Namespace
	if s == nil {
		t.Fatal("Namespace summary is nil")
	}
	if s.Phase != "Active" {
		t.Errorf("phase = %q, want Active", s.Phase)
	}
	if s.Labels["team"] != "a" {
		t.Errorf("labels = %v, want team=a", s.Labels)
	}
	if s.PodCount != 2 {
		t.Errorf("PodCount = %d, want 2 (only pods in team-a)", s.PodCount)
	}
}

func TestBuildPodDetail(t *testing.T) {
	p := pod("default", "web", "node-a", corev1.PodRunning)
	p.UID = types.UID("uid-web")
	p.Spec.Containers = []corev1.Container{
		{Name: "app", Image: "nginx:1"},
		{Name: "sidecar", Image: "envoy:1"},
	}
	p.Status.ContainerStatuses = []corev1.ContainerStatus{
		{
			Name: "app", Image: "nginx:1", Ready: true, RestartCount: 2,
			State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		},
		{
			Name: "sidecar", Image: "envoy:1", Ready: false, RestartCount: 5,
			State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
		},
	}

	now := metav1.NewTime(time.Now())
	older := metav1.NewTime(time.Now().Add(-time.Hour))
	client := fake.NewSimpleClientset(
		p,
		podEvent("default", "e-new", "web", "uid-web", "Warning", "BackOff", now),
		podEvent("default", "e-old", "web", "uid-web", "Normal", "Scheduled", older),
		podEvent("default", "e-other", "other-pod", "uid-other", "Normal", "Pulled", now),
	)

	detail, err := kube.BuildPodDetail(context.Background(), client, "default", "web")
	if err != nil {
		t.Fatalf("BuildPodDetail: %v", err)
	}

	if detail.Namespace != "default" || detail.Pod != "web" || detail.Node != "node-a" {
		t.Errorf("identity = %q/%q on %q", detail.Namespace, detail.Pod, detail.Node)
	}
	// The crash-looping sidecar drives the derived phase, matching a Panel.
	if detail.Phase != scene.PodPhaseCrashLoopBackOff {
		t.Errorf("phase = %q, want CrashLoopBackOff", detail.Phase)
	}
	if detail.Color != scene.ColorForPhase(scene.PodPhaseCrashLoopBackOff) {
		t.Errorf("color = %q, want crash-loop color", detail.Color)
	}
	if detail.RestartCount != 7 {
		t.Errorf("RestartCount = %d, want 7 (2+5)", detail.RestartCount)
	}

	if len(detail.Containers) != 2 {
		t.Fatalf("containers = %d, want 2", len(detail.Containers))
	}
	if detail.Containers[0].Name != "app" || detail.Containers[0].State != "Running" {
		t.Errorf("container[0] = %+v, want app/Running (spec order)", detail.Containers[0])
	}
	if detail.Containers[1].State != "Waiting" || detail.Containers[1].Reason != "CrashLoopBackOff" {
		t.Errorf("container[1] = %+v, want Waiting/CrashLoopBackOff", detail.Containers[1])
	}

	// Only this pod's events, newest first, other pod excluded.
	if len(detail.Events) != 2 {
		t.Fatalf("events = %d, want 2 (this pod only): %+v", len(detail.Events), detail.Events)
	}
	if detail.Events[0].Reason != "BackOff" || detail.Events[1].Reason != "Scheduled" {
		t.Errorf("events order = %q,%q, want BackOff,Scheduled (newest first)",
			detail.Events[0].Reason, detail.Events[1].Reason)
	}
	if detail.Events[0].LastSeen == "" {
		t.Error("event LastSeen is empty, want an RFC3339 timestamp")
	}
}

func TestBuildPodDetail_NotFound(t *testing.T) {
	client := fake.NewSimpleClientset()
	_, err := kube.BuildPodDetail(context.Background(), client, "default", "ghost")
	if err == nil {
		t.Fatal("want an error for a missing pod")
	}
	if !apierrors.IsNotFound(err) {
		t.Errorf("error = %v, want a NotFound", err)
	}
}

// TestBuildPodDetail_EventsBestEffort asserts a failure listing Events degrades
// to no events rather than failing the whole detail (ADR-0002).
func TestBuildPodDetail_EventsBestEffort(t *testing.T) {
	p := pod("default", "web", "node-a", corev1.PodRunning)
	client := fake.NewSimpleClientset(p)
	client.PrependReactor("list", "events", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("events forbidden")
	})

	detail, err := kube.BuildPodDetail(context.Background(), client, "default", "web")
	if err != nil {
		t.Fatalf("BuildPodDetail should not fail on an events error: %v", err)
	}
	if detail.Events == nil {
		t.Error("Events is nil, want a non-nil empty slice")
	}
	if len(detail.Events) != 0 {
		t.Errorf("events = %d, want 0", len(detail.Events))
	}
}

// podEvent builds a fake Event about a pod for the events tests.
func podEvent(namespace, name, podName, podUID, eventType, reason string, last metav1.Time) *corev1.Event {
	return &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		InvolvedObject: corev1.ObjectReference{
			Kind:      "Pod",
			Name:      podName,
			Namespace: namespace,
			UID:       types.UID(podUID),
		},
		Type:          eventType,
		Reason:        reason,
		Message:       reason + " message",
		Count:         1,
		LastTimestamp: last,
	}
}
