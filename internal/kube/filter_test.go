package kube_test

import (
	"context"
	"reflect"
	"sort"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// labeledNamespace builds a Namespace carrying the given labels, for exercising
// the label-mode filter.
func labeledNamespace(name string, lbls map[string]string) *corev1.Namespace {
	ns := namespace(name)
	ns.Labels = lbls
	return ns
}

// labeledProject builds an OpenShift Project (unstructured) carrying labels, for
// the label-mode filter's Project-fallback path.
func labeledProject(name string, lbls map[string]string) *unstructured.Unstructured {
	p := project(name)
	meta := p.Object["metadata"].(map[string]any)
	l := make(map[string]any, len(lbls))
	for k, v := range lbls {
		l[k] = v
	}
	meta["labels"] = l
	return p
}

// mustNameFilter builds a name-pattern filter, failing the test on a bad pattern.
func mustNameFilter(t *testing.T, pattern string) kube.NamespaceFilter {
	t.Helper()
	f, err := kube.NameFilter(pattern)
	if err != nil {
		t.Fatalf("NameFilter(%q): %v", pattern, err)
	}
	return f
}

// mustLabelFilter builds a label-selector filter, failing on a bad selector.
func mustLabelFilter(t *testing.T, selector string) kube.NamespaceFilter {
	t.Helper()
	f, err := kube.LabelFilter(selector)
	if err != nil {
		t.Fatalf("LabelFilter(%q): %v", selector, err)
	}
	return f
}

// towerNames returns the Tower names in scene order.
func towerNames(towers []scene.Tower) []string {
	names := make([]string, len(towers))
	for i, tw := range towers {
		names[i] = tw.Name
	}
	return names
}

// panelPods returns the pod names across every Tower's Panels, sorted, so a test
// can assert which pods survived filtering regardless of Tower layout.
func panelPods(towers []scene.Tower) []string {
	var pods []string
	for _, tw := range towers {
		for _, p := range tw.Panels {
			pods = append(pods, p.Pod)
		}
	}
	sort.Strings(pods)
	return pods
}

// --- Constructor validation --------------------------------------------------

func TestNameFilter_EmptyIsInactive(t *testing.T) {
	f, err := kube.NameFilter("")
	if err != nil {
		t.Fatalf("NameFilter(\"\"): %v", err)
	}
	if f.Active() {
		t.Fatal("empty name pattern produced an active filter, want the no-filter default")
	}
}

func TestNameFilter_MalformedPatternRejected(t *testing.T) {
	if _, err := kube.NameFilter("openshift-[a"); err == nil {
		t.Fatal("expected an error for a malformed glob, got nil")
	}
}

func TestLabelFilter_EmptyIsInactive(t *testing.T) {
	f, err := kube.LabelFilter("   ")
	if err != nil {
		t.Fatalf("LabelFilter(blank): %v", err)
	}
	if f.Active() {
		t.Fatal("blank selector produced an active filter, want the no-filter default")
	}
}

func TestLabelFilter_MalformedSelectorRejected(t *testing.T) {
	if _, err := kube.LabelFilter("=nope"); err == nil {
		t.Fatal("expected an error for a malformed selector, got nil")
	}
}

// --- No-filter default: nothing hidden --------------------------------------

// TestBuildTowers_NoFilterShowsAllNamespaces is the "nothing excluded by
// default" acceptance criterion: the zero-value filter admits every namespace.
func TestBuildTowers_NoFilterShowsAllNamespaces(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("openshift-api"), namespace("default"), namespace("team-a"),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if want := []string{"default", "openshift-api", "team-a"}; !reflect.DeepEqual(towerNames(got), want) {
		t.Fatalf("tower names = %v, want %v (all namespaces)", towerNames(got), want)
	}
}

// --- Name-pattern mode (default) --------------------------------------------

// TestBuildTowers_NameFilter_Wildcard is the name-pattern acceptance criterion:
// a wildcard pattern (openshift-*) selects only the matching Namespace Towers,
// and the surviving set is laid out compactly (positions span just the kept
// names, no gaps left by the excluded ones).
func TestBuildTowers_NameFilter_Wildcard(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("openshift-apiserver"),
		namespace("openshift-console"),
		namespace("default"),
		namespace("kube-system"),
		namespace("team-a"),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, mustNameFilter(t, "openshift-*"))
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}

	want := []scene.Tower{
		{Name: "openshift-apiserver", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "openshift-console", Grid: scene.GridPosition{Col: 1, Row: 0}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("towers = %+v, want %+v", got, want)
	}
}

// TestBuildTowers_NameFilter_ExactAndQuestionMark proves the glob is anchored to
// the whole name (an exact name matches only itself, not a superstring) and that
// the "?" single-character wildcard works.
func TestBuildTowers_NameFilter_ExactAndQuestionMark(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("prod"), namespace("prod-1"), namespace("prod1"), namespace("prods"),
	)

	exact, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, mustNameFilter(t, "prod"))
	if err != nil {
		t.Fatalf("BuildTowers exact: %v", err)
	}
	if got := towerNames(exact); !reflect.DeepEqual(got, []string{"prod"}) {
		t.Fatalf("exact 'prod' matched %v, want [prod] only (anchored, not a prefix)", got)
	}

	q, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, mustNameFilter(t, "prod?"))
	if err != nil {
		t.Fatalf("BuildTowers question: %v", err)
	}
	// "prod?" matches exactly one trailing char: prod1 and prods, not prod or prod-1... prod-1 has two.
	if got := towerNames(q); !reflect.DeepEqual(got, []string{"prod1", "prods"}) {
		t.Fatalf("'prod?' matched %v, want [prod1 prods]", got)
	}
}

// --- Label mode (advanced) --------------------------------------------------

// TestBuildTowers_LabelFilter_NamespaceMode is the label-mode acceptance
// criterion in Namespace-mode: only Namespaces whose labels satisfy the selector
// become Towers. The match uses the Namespace objects' own labels.
func TestBuildTowers_LabelFilter_NamespaceMode(t *testing.T) {
	client := fake.NewSimpleClientset(
		labeledNamespace("platform-a", map[string]string{"team": "platform"}),
		labeledNamespace("platform-b", map[string]string{"team": "platform", "tier": "infra"}),
		labeledNamespace("payments", map[string]string{"team": "payments"}),
		namespace("unlabeled"),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, mustLabelFilter(t, "team=platform"))
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if want := []string{"platform-a", "platform-b"}; !reflect.DeepEqual(towerNames(got), want) {
		t.Fatalf("tower names = %v, want %v", towerNames(got), want)
	}
}

// TestBuildTowers_LabelFilter_Inequality exercises a set-based selector
// (team=platform,tier!=infra) to prove the full labels.Selector grammar is
// honored, not just simple equality.
func TestBuildTowers_LabelFilter_Inequality(t *testing.T) {
	client := fake.NewSimpleClientset(
		labeledNamespace("platform-a", map[string]string{"team": "platform"}),
		labeledNamespace("platform-b", map[string]string{"team": "platform", "tier": "infra"}),
	)

	got, err := kube.BuildTowers(context.Background(), client, nil, scene.ViewModeNamespace, mustLabelFilter(t, "team=platform,tier!=infra"))
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if want := []string{"platform-a"}; !reflect.DeepEqual(towerNames(got), want) {
		t.Fatalf("tower names = %v, want %v", towerNames(got), want)
	}
}

// --- End-to-end via BuildScene ----------------------------------------------

// TestBuildScene_NamespaceMode_NameFilter proves the filter reaches Panels in
// Namespace-mode by filtering the Towers: pods in an excluded namespace have no
// Tower and are dropped, so only the admitted namespace's Panels remain.
func TestBuildScene_NamespaceMode_NameFilter(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("openshift-api"), namespace("team-a"),
		pod("openshift-api", "apiserver", "node-1", corev1.PodRunning),
		pod("team-a", "web", "node-1", corev1.PodRunning),
	)

	got := kube.BuildScene(context.Background(), client, nil, scene.ViewModeNamespace, mustNameFilter(t, "openshift-*"))

	if want := []string{"openshift-api"}; !reflect.DeepEqual(towerNames(got.Towers), want) {
		t.Fatalf("tower names = %v, want %v", towerNames(got.Towers), want)
	}
	if want := []string{"apiserver"}; !reflect.DeepEqual(panelPods(got.Towers), want) {
		t.Fatalf("panel pods = %v, want %v (team-a's pod dropped with its Tower)", panelPods(got.Towers), want)
	}
}

// TestBuildScene_NodeMode_NameFilterScopesPods is the documented Node-mode
// behavior: Node Towers are never hidden by the filter, but only pods in an
// admitted namespace keep a Panel. Both nodes remain; the team-a pod is dropped.
func TestBuildScene_NodeMode_NameFilterScopesPods(t *testing.T) {
	client := fake.NewSimpleClientset(
		node("node-1"), node("node-2"),
		pod("openshift-api", "apiserver", "node-1", corev1.PodRunning),
		pod("team-a", "web", "node-2", corev1.PodRunning),
	)

	got := kube.BuildScene(context.Background(), client, nil, scene.ViewModeNode, mustNameFilter(t, "openshift-*"))

	if want := []string{"node-1", "node-2"}; !reflect.DeepEqual(towerNames(got.Towers), want) {
		t.Fatalf("tower names = %v, want %v (Node Towers never hidden by the filter)", towerNames(got.Towers), want)
	}
	if want := []string{"apiserver"}; !reflect.DeepEqual(panelPods(got.Towers), want) {
		t.Fatalf("panel pods = %v, want %v (only openshift-* pods keep a Panel)", panelPods(got.Towers), want)
	}
}

// TestBuildScene_NodeMode_LabelFilterScopesPods proves label mode also scopes
// pods in Node-mode: the predicate resolves which namespace names carry matching
// labels (by listing Namespaces server-side), then keeps only those pods.
func TestBuildScene_NodeMode_LabelFilterScopesPods(t *testing.T) {
	client := fake.NewSimpleClientset(
		node("node-1"), node("node-2"),
		labeledNamespace("platform", map[string]string{"team": "platform"}),
		labeledNamespace("payments", map[string]string{"team": "payments"}),
		pod("platform", "gateway", "node-1", corev1.PodRunning),
		pod("payments", "ledger", "node-2", corev1.PodRunning),
	)

	got := kube.BuildScene(context.Background(), client, nil, scene.ViewModeNode, mustLabelFilter(t, "team=platform"))

	if want := []string{"node-1", "node-2"}; !reflect.DeepEqual(towerNames(got.Towers), want) {
		t.Fatalf("tower names = %v, want both Nodes", towerNames(got.Towers))
	}
	if want := []string{"gateway"}; !reflect.DeepEqual(panelPods(got.Towers), want) {
		t.Fatalf("panel pods = %v, want %v (only the platform-labeled namespace's pod)", panelPods(got.Towers), want)
	}
}

// TestBuildScene_NoFilterKeepsEveryPod confirms the no-filter default hides
// nothing in Node-mode either: every pod keeps its Panel.
func TestBuildScene_NoFilterKeepsEveryPod(t *testing.T) {
	client := fake.NewSimpleClientset(
		node("node-1"),
		pod("openshift-api", "apiserver", "node-1", corev1.PodRunning),
		pod("team-a", "web", "node-1", corev1.PodRunning),
	)

	got := kube.BuildScene(context.Background(), client, nil, scene.ViewModeNode, kube.NamespaceFilter{})

	if want := []string{"apiserver", "web"}; !reflect.DeepEqual(panelPods(got.Towers), want) {
		t.Fatalf("panel pods = %v, want %v (nothing hidden by default)", panelPods(got.Towers), want)
	}
}

// TestBuildScene_NodeMode_LabelFilter_FailsOpenWhenUnresolvable proves the
// ADR-0002 graceful degradation: when a Node-mode label filter cannot be
// resolved (namespaces unlistable and no Project fallback), the scene admits all
// pods rather than blanking — nothing hidden trumps hiding everything on an RBAC
// gap.
func TestBuildScene_NodeMode_LabelFilter_FailsOpenWhenUnresolvable(t *testing.T) {
	client := fake.NewSimpleClientset(
		node("node-1"),
		pod("platform", "gateway", "node-1", corev1.PodRunning),
		pod("payments", "ledger", "node-1", corev1.PodRunning),
	)
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())

	// nil dynamic client → no Project fallback → the label filter can't resolve.
	got := kube.BuildScene(context.Background(), client, nil, scene.ViewModeNode, mustLabelFilter(t, "team=platform"))

	if want := []string{"gateway", "ledger"}; !reflect.DeepEqual(panelPods(got.Towers), want) {
		t.Fatalf("panel pods = %v, want %v (fail-open: all pods admitted)", panelPods(got.Towers), want)
	}
}

// --- OpenShift Project fallback + filter -------------------------------------

// TestBuildTowers_NameFilter_ProjectFallback proves name filtering also applies
// on the OpenShift Project-fallback path (Namespaces unlistable), so a restricted
// OpenShift user gets the same filtered Towers.
func TestBuildTowers_NameFilter_ProjectFallback(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())
	dyn := projectDynamicClient(project("openshift-monitoring"), project("team-a"), project("openshift-logging"))

	got, err := kube.BuildTowers(context.Background(), client, dyn, scene.ViewModeNamespace, mustNameFilter(t, "openshift-*"))
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if want := []string{"openshift-logging", "openshift-monitoring"}; !reflect.DeepEqual(towerNames(got), want) {
		t.Fatalf("tower names = %v, want %v", towerNames(got), want)
	}
}

// TestBuildTowers_LabelFilter_ProjectFallback proves label filtering applies to
// the Project fallback too, matching each Project's own labels client-side.
func TestBuildTowers_LabelFilter_ProjectFallback(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())
	dyn := projectDynamicClient(
		labeledProject("platform", map[string]string{"team": "platform"}),
		labeledProject("payments", map[string]string{"team": "payments"}),
	)

	got, err := kube.BuildTowers(context.Background(), client, dyn, scene.ViewModeNamespace, mustLabelFilter(t, "team=platform"))
	if err != nil {
		t.Fatalf("BuildTowers: %v", err)
	}
	if want := []string{"platform"}; !reflect.DeepEqual(towerNames(got), want) {
		t.Fatalf("tower names = %v, want %v", towerNames(got), want)
	}
}
