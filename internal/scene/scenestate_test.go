package scene_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// TestSceneState_JSONWireShape pins the on-the-wire JSON of a SceneState,
// including a Tower's nested Panels. This is the contract the generated
// TypeScript mirrors (see the root Taskfile's `codegen` target): the field
// names, the View Mode string values, and the Tower/GridPosition/Panel shape
// are what the frontend parses, so a change here is a deliberate wire-contract
// change that must be regenerated. Panels are nested under their Tower (a Panel
// carries no Tower reference); a Tower with no pods carries an empty array.
func TestSceneState_JSONWireShape(t *testing.T) {
	state := scene.SceneState{
		ViewMode: scene.ViewModeNode,
		Towers: []scene.Tower{
			{
				Name: "alpha",
				Grid: scene.GridPosition{Col: 0, Row: 0},
				Panels: []scene.Panel{
					{Namespace: "default", Pod: "web", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
				},
			},
			{Name: "bravo", Grid: scene.GridPosition{Col: 1, Row: 0}, Panels: []scene.Panel{}},
		},
	}

	got, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal SceneState: %v", err)
	}

	const want = `{"viewMode":"node","towers":[` +
		`{"name":"alpha","grid":{"col":0,"row":0},"panels":[` +
		`{"namespace":"default","pod":"web","phase":"Running","color":"#39ff14"}]},` +
		`{"name":"bravo","grid":{"col":1,"row":0},"panels":[]}]}`
	if string(got) != want {
		t.Fatalf("SceneState JSON = %s, want %s", got, want)
	}
}

// TestColorForPhase_UnknownFallback proves an unrecognized phase (including the
// empty string) maps to the Unknown color, so an unexpected value never yields
// an empty color on the wire.
func TestColorForPhase_UnknownFallback(t *testing.T) {
	for _, ph := range []scene.PodPhase{"", "NotARealPhase", "Terminating"} {
		if got := scene.ColorForPhase(ph); got != scene.ColorUnknown {
			t.Errorf("ColorForPhase(%q) = %q, want %q", ph, got, scene.ColorUnknown)
		}
	}
}

// TestSceneState_RoundTrip proves a serialized SceneState deserializes back to
// an equal value — the snapshot the backend sends on connect (ADR-0007) is
// exactly what a client reading the wire recovers. SceneState now carries a
// Tower slice, so it is compared with reflect.DeepEqual rather than ==.
func TestSceneState_RoundTrip(t *testing.T) {
	for _, mode := range []scene.ViewMode{scene.ViewModeNode, scene.ViewModeNamespace} {
		want := scene.SceneState{
			ViewMode: mode,
			Towers: []scene.Tower{
				{
					Name: "one",
					Grid: scene.GridPosition{Col: 0, Row: 0},
					Panels: []scene.Panel{
						{Namespace: "default", Pod: "web", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
					},
				},
				{Name: "two", Grid: scene.GridPosition{Col: 1, Row: 0}, Panels: []scene.Panel{}},
			},
		}

		data, err := json.Marshal(want)
		if err != nil {
			t.Fatalf("marshal %q: %v", mode, err)
		}

		var got scene.SceneState
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("unmarshal %s: %v", data, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("round-trip = %+v, want %+v", got, want)
		}
	}
}
