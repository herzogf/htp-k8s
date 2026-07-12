package scene_test

import (
	"encoding/json"
	"testing"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// TestSceneState_JSONWireShape pins the on-the-wire JSON of a SceneState. This
// is the contract the generated TypeScript mirrors (see the root Taskfile's
// `codegen` target): the field name and the View Mode string values are what
// the frontend parses, so a change here is a deliberate wire-contract change
// that must be regenerated.
func TestSceneState_JSONWireShape(t *testing.T) {
	got, err := json.Marshal(scene.SceneState{ViewMode: scene.ViewModeNode})
	if err != nil {
		t.Fatalf("marshal SceneState: %v", err)
	}

	const want = `{"viewMode":"node"}`
	if string(got) != want {
		t.Fatalf("SceneState JSON = %s, want %s", got, want)
	}
}

// TestSceneState_RoundTrip proves a serialized SceneState deserializes back to
// an equal value — the snapshot the backend sends on connect (ADR-0007) is
// exactly what a client reading the wire recovers.
func TestSceneState_RoundTrip(t *testing.T) {
	for _, mode := range []scene.ViewMode{scene.ViewModeNode, scene.ViewModeNamespace} {
		want := scene.SceneState{ViewMode: mode}

		data, err := json.Marshal(want)
		if err != nil {
			t.Fatalf("marshal %q: %v", mode, err)
		}

		var got scene.SceneState
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("unmarshal %s: %v", data, err)
		}
		if got != want {
			t.Fatalf("round-trip = %+v, want %+v", got, want)
		}
	}
}
