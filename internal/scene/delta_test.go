package scene_test

import (
	"reflect"
	"testing"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// panel builds a Panel with its Color derived from phase, the way kube.BuildPanels
// does, so tests construct Panels the same way the real scene does.
func panel(namespace, pod string, phase scene.PodPhase) scene.Panel {
	return scene.Panel{
		Namespace: namespace,
		Pod:       pod,
		Phase:     phase,
		Color:     scene.ColorForPhase(phase),
	}
}

// tower builds a Tower at a grid position carrying the given Panels.
func tower(name string, col, row int, panels ...scene.Panel) scene.Tower {
	if panels == nil {
		panels = []scene.Panel{}
	}
	return scene.Tower{
		Name:   name,
		Grid:   scene.GridPosition{Col: col, Row: row},
		Panels: panels,
	}
}

func sceneState(mode scene.ViewMode, towers ...scene.Tower) scene.SceneState {
	return scene.SceneState{ViewMode: mode, Towers: towers}
}

func TestDiff_NoChange(t *testing.T) {
	s := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning)),
		tower("node-b", 1, 0),
	)
	if got := scene.Diff(s, s); got != nil {
		t.Fatalf("Diff of identical scenes = %+v, want nil", got)
	}
}

func TestDiff_TowerAdded_CarriesWholeTowerWithPanels(t *testing.T) {
	prev := sceneState(scene.ViewModeNamespace,
		tower("ns-a", 0, 0),
	)
	// ns-b appears; grid recomputes to a 2-wide row, ns-a stays put.
	newTower := tower("ns-b", 1, 0, panel("ns-b", "p1", scene.PodPhasePending))
	next := sceneState(scene.ViewModeNamespace,
		tower("ns-a", 0, 0),
		newTower,
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaTowerAdded, Tower: &newTower},
	}
	assertDeltas(t, got, want)
}

func TestDiff_TowerRemoved_NoPanelDeltasForItsPanels(t *testing.T) {
	prev := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0),
		tower("node-b", 1, 0, panel("ns", "p1", scene.PodPhaseRunning)),
	)
	// node-b removed; the sole remaining Tower collapses to a 1-wide grid, but
	// node-a is already at (0,0) so it does not move.
	next := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaTowerRemoved, TowerName: "node-b"},
	}
	assertDeltas(t, got, want)
}

// TestDiff_TowerAdded_ShiftsOthers proves the grid-relayout case: adding a Tower
// that sorts first pushes an existing Tower to a new grid slot, which must
// surface as a DeltaTowerMoved alongside the DeltaTowerAdded.
func TestDiff_TowerAdded_ShiftsOthers(t *testing.T) {
	// Two towers on one row.
	prev := sceneState(scene.ViewModeNode,
		tower("node-b", 0, 0),
		tower("node-c", 1, 0),
	)
	// node-a sorts first: with three towers the grid is 2 wide, so
	// node-a→(0,0), node-b→(1,0), node-c→(0,1). node-b and node-c both move.
	addedA := tower("node-a", 0, 0)
	next := sceneState(scene.ViewModeNode,
		addedA,
		tower("node-b", 1, 0),
		tower("node-c", 0, 1),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaTowerAdded, Tower: &addedA},
		{Type: scene.DeltaTowerMoved, TowerName: "node-b", Grid: &scene.GridPosition{Col: 1, Row: 0}},
		{Type: scene.DeltaTowerMoved, TowerName: "node-c", Grid: &scene.GridPosition{Col: 0, Row: 1}},
	}
	assertDeltas(t, got, want)
}

func TestDiff_PanelAdded(t *testing.T) {
	prev := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning)),
	)
	added := panel("ns", "p2", scene.PodPhasePending)
	next := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning), added),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaPanelAdded, TowerName: "node-a", Panel: &added},
	}
	assertDeltas(t, got, want)
}

func TestDiff_PanelRemoved(t *testing.T) {
	prev := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning), panel("ns", "p2", scene.PodPhaseRunning)),
	)
	next := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning)),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaPanelRemoved, TowerName: "node-a", Namespace: "ns", Pod: "p2"},
	}
	assertDeltas(t, got, want)
}

func TestDiff_PanelUpdated_PhaseChange(t *testing.T) {
	prev := sceneState(scene.ViewModeNamespace,
		tower("ns", 0, 0, panel("ns", "p1", scene.PodPhasePending)),
	)
	updated := panel("ns", "p1", scene.PodPhaseRunning)
	next := sceneState(scene.ViewModeNamespace,
		tower("ns", 0, 0, updated),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaPanelUpdated, TowerName: "ns", Panel: &updated},
	}
	assertDeltas(t, got, want)
	// The updated Panel must carry the new color, not the old one.
	if got[0].Panel.Color != scene.ColorRunning {
		t.Errorf("updated panel color = %q, want %q", got[0].Panel.Color, scene.ColorRunning)
	}
}

// TestDiff_PodReHomesBetweenTowers models a pod rescheduling to another Node in
// Node-mode: the Panel leaves its old Tower and appears on the new one, which is
// a remove + add across two surviving Towers, not an update.
func TestDiff_PodReHomesBetweenTowers(t *testing.T) {
	prev := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0, panel("ns", "p1", scene.PodPhaseRunning)),
		tower("node-b", 1, 0),
	)
	moved := panel("ns", "p1", scene.PodPhaseRunning)
	next := sceneState(scene.ViewModeNode,
		tower("node-a", 0, 0),
		tower("node-b", 1, 0, moved),
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaPanelRemoved, TowerName: "node-a", Namespace: "ns", Pod: "p1"},
		{Type: scene.DeltaPanelAdded, TowerName: "node-b", Panel: &moved},
	}
	assertDeltas(t, got, want)
}

// TestDiff_DeterministicOrder pins the documented emission order: tower removals,
// then additions, then moves, then per surviving tower (sorted) its panel
// removals, additions, updates.
func TestDiff_DeterministicOrder(t *testing.T) {
	prev := sceneState(scene.ViewModeNode,
		tower("keep", 0, 0, panel("ns", "old", scene.PodPhaseRunning), panel("ns", "chg", scene.PodPhasePending)),
		tower("gone", 1, 0),
	)
	addedTower := tower("new", 1, 0)
	addedPanel := panel("ns", "add", scene.PodPhaseRunning)
	changedPanel := panel("ns", "chg", scene.PodPhaseRunning)
	next := sceneState(scene.ViewModeNode,
		tower("keep", 0, 0, changedPanel, addedPanel),
		addedTower,
	)

	got := scene.Diff(prev, next)
	want := []scene.SceneDelta{
		{Type: scene.DeltaTowerRemoved, TowerName: "gone"},
		{Type: scene.DeltaTowerAdded, Tower: &addedTower},
		{Type: scene.DeltaPanelRemoved, TowerName: "keep", Namespace: "ns", Pod: "old"},
		{Type: scene.DeltaPanelAdded, TowerName: "keep", Panel: &addedPanel},
		{Type: scene.DeltaPanelUpdated, TowerName: "keep", Panel: &changedPanel},
	}
	assertDeltas(t, got, want)
}

// assertDeltas compares two delta slices for deep equality (dereferencing the
// pointer payloads), failing with a readable dump on mismatch.
func assertDeltas(t *testing.T, got, want []scene.SceneDelta) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d deltas, want %d\n got: %s\nwant: %s", len(got), len(want), formatDeltas(got), formatDeltas(want))
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Errorf("delta[%d] = %s, want %s", i, formatDelta(got[i]), formatDelta(want[i]))
		}
	}
}

func formatDeltas(ds []scene.SceneDelta) string {
	out := "["
	for i, d := range ds {
		if i > 0 {
			out += ", "
		}
		out += formatDelta(d)
	}
	return out + "]"
}

func formatDelta(d scene.SceneDelta) string {
	s := string(d.Type)
	if d.Tower != nil {
		s += "{tower=" + d.Tower.Name + "}"
	}
	if d.TowerName != "" {
		s += "{towerName=" + d.TowerName + "}"
	}
	if d.Grid != nil {
		s += "{grid}"
	}
	if d.Panel != nil {
		s += "{panel=" + d.Panel.Namespace + "/" + d.Panel.Pod + ":" + string(d.Panel.Phase) + "}"
	}
	if d.Pod != "" {
		s += "{pod=" + d.Namespace + "/" + d.Pod + "}"
	}
	return s
}
