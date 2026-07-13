package scene

import "sort"

// SceneDeltaType is the discriminator tag on a SceneDelta: it names which kind
// of change the delta describes so the frontend can narrow on it (a discriminated
// union keyed by the `type` field). Every SceneDelta carries exactly one of
// these values, and the payload fields that are populated depend on it (see
// SceneDelta).
type SceneDeltaType string

const (
	// DeltaTowerAdded is a Tower that appeared in the scene (a Node in
	// Node-mode, or a Namespace/Project in Namespace-mode, became visible).
	// The delta carries the full new Tower in SceneDelta.Tower, including any
	// Panels it already has, so the frontend can add it outright.
	DeltaTowerAdded SceneDeltaType = "towerAdded"
	// DeltaTowerRemoved is a Tower that left the scene. The delta carries only
	// SceneDelta.TowerName; the frontend drops that Tower and every Panel on it.
	DeltaTowerRemoved SceneDeltaType = "towerRemoved"
	// DeltaTowerMoved is a surviving Tower whose grid position changed. Because
	// the grid-by-name layout is a pure function of the sorted set of Tower
	// names (see the kube layout), adding or removing one Tower can shift
	// others; this delta carries the Tower's new SceneDelta.Grid so the frontend
	// re-places it without recomputing the layout itself.
	DeltaTowerMoved SceneDeltaType = "towerMoved"
	// DeltaPanelAdded is a Panel that appeared on an existing Tower (a Pod
	// became visible under this Tower). The delta carries SceneDelta.TowerName
	// and the full SceneDelta.Panel. Panels on a brand-new Tower arrive inside
	// its DeltaTowerAdded instead, never as separate DeltaPanelAdded messages.
	DeltaPanelAdded SceneDeltaType = "panelAdded"
	// DeltaPanelUpdated is a Panel on an existing Tower whose content changed
	// (e.g. its Pod's phase, and so its color, changed). The delta carries
	// SceneDelta.TowerName and the full replacement SceneDelta.Panel.
	DeltaPanelUpdated SceneDeltaType = "panelUpdated"
	// DeltaPanelRemoved is a Panel that left an existing Tower (its Pod is gone,
	// or re-homed to another Tower). The delta identifies the Panel by
	// SceneDelta.TowerName plus SceneDelta.Namespace and SceneDelta.Pod. Panels
	// on a removed Tower are not reported individually — the DeltaTowerRemoved
	// already drops them.
	DeltaPanelRemoved SceneDeltaType = "panelRemoved"
)

// SceneDelta is one incremental change to the scene (see CONTEXT.md's "Scene
// Delta") sent from backend to frontend after the initial SceneState snapshot,
// per ADR-0007. It is a discriminated union keyed by Type: the frontend switches
// on Type and reads only the payload fields that kind populates. The optional
// fields are pointers/omitempty so an unset one is omitted from the wire (and
// typed as optional in the generated TypeScript) rather than sent as a zero value.
//
// The deltas mirror Kubernetes' own LIST + WATCH: a SceneState snapshot is the
// LIST, and the SceneDelta stream is the WATCH translated into scene-domain
// terms. Applying a scene's deltas in order to the snapshot they followed
// reproduces the later snapshot exactly (see Diff), which is the property the
// frontend reconciliation reducer relies on.
type SceneDelta struct {
	// Type names which kind of change this is and which payload fields below
	// are populated. Always set.
	Type SceneDeltaType `json:"type"`

	// Tower is the full new Tower for DeltaTowerAdded (and only that kind),
	// including its initial Panels. Nil for every other kind.
	Tower *Tower `json:"tower,omitempty"`

	// TowerName identifies the affected Tower for every kind except
	// DeltaTowerAdded (which carries the Tower whole in Tower). It is the Tower
	// the change happened to or on.
	TowerName string `json:"towerName,omitempty"`

	// Grid is the Tower's new grid position for DeltaTowerMoved. Nil otherwise.
	Grid *GridPosition `json:"grid,omitempty"`

	// Panel is the full Panel for DeltaPanelAdded and DeltaPanelUpdated. Nil
	// otherwise.
	Panel *Panel `json:"panel,omitempty"`

	// Namespace and Pod identify the affected Panel for DeltaPanelRemoved (a
	// Panel's identity is its Pod's cluster-unique Namespace/Pod pair). Empty
	// otherwise.
	Namespace string `json:"namespace,omitempty"`
	Pod       string `json:"pod,omitempty"`
}

// Diff computes the ordered set of SceneDeltas that transforms the prev scene
// into the next scene: apply them in order to prev and you get next. It is the
// pure heart of ADR-0007's "k8s watch events in → Scene Deltas out" seam —
// given two SceneState snapshots (a rebuild-and-diff, so it is robust to missed
// or coalesced watch events rather than translating each event by hand) it
// yields the minimal structural changes, and nothing when the scenes are equal.
//
// Both scenes are assumed to be in the same View Mode (a mode switch is handled
// by a fresh snapshot, not a delta). The result is deterministic — the same
// prev/next always yield the same delta slice in the same order — and ordered so
// a reducer can apply it safely: Tower removals, then additions, then moves,
// then per surviving Tower (sorted by name) its Panel removals, additions, and
// updates. Panels of an added Tower ride inside its DeltaTowerAdded, and Panels
// of a removed Tower are dropped with it, so Panel deltas are only ever emitted
// for Towers present in both scenes. The returned slice is nil when there is no
// change.
func Diff(prev, next SceneState) []SceneDelta {
	prevTowers := towersByName(prev.Towers)
	nextTowers := towersByName(next.Towers)

	var deltas []SceneDelta

	// Tower removals: in prev, gone from next.
	for _, name := range sortedTowerNames(prevTowers) {
		if _, ok := nextTowers[name]; !ok {
			deltas = append(deltas, SceneDelta{Type: DeltaTowerRemoved, TowerName: name})
		}
	}

	// Tower additions: in next, not in prev. Carries the whole Tower.
	for _, name := range sortedTowerNames(nextTowers) {
		if _, ok := prevTowers[name]; !ok {
			tower := nextTowers[name]
			deltas = append(deltas, SceneDelta{Type: DeltaTowerAdded, Tower: &tower})
		}
	}

	// Tower moves: present in both, grid changed.
	for _, name := range sortedTowerNames(nextTowers) {
		before, ok := prevTowers[name]
		if !ok {
			continue
		}
		after := nextTowers[name]
		if before.Grid != after.Grid {
			grid := after.Grid
			deltas = append(deltas, SceneDelta{Type: DeltaTowerMoved, TowerName: name, Grid: &grid})
		}
	}

	// Panel deltas for surviving Towers (present in both scenes), sorted by
	// Tower name for determinism.
	for _, name := range sortedTowerNames(nextTowers) {
		before, ok := prevTowers[name]
		if !ok {
			continue
		}
		after := nextTowers[name]
		deltas = append(deltas, panelDeltas(name, before.Panels, after.Panels)...)
	}

	return deltas
}

// panelDeltas computes the Panel-level deltas for one surviving Tower named
// towerName, comparing its Panels before and after by the Pod's cluster-unique
// (Namespace, Pod) identity. Removals come first, then additions, then updates,
// each in the deterministic (Namespace, Pod) order, so the whole diff is stable.
// A Panel present in both whose content differs (e.g. phase/color) yields one
// DeltaPanelUpdated.
func panelDeltas(towerName string, before, after []Panel) []SceneDelta {
	beforeByID := panelsByID(before)
	afterByID := panelsByID(after)

	var deltas []SceneDelta

	// Removals: in before, gone from after.
	for _, id := range sortedPanelIDs(beforeByID) {
		if _, ok := afterByID[id]; !ok {
			deltas = append(deltas, SceneDelta{
				Type:      DeltaPanelRemoved,
				TowerName: towerName,
				Namespace: id.namespace,
				Pod:       id.pod,
			})
		}
	}

	// Additions: in after, not in before.
	for _, id := range sortedPanelIDs(afterByID) {
		if _, ok := beforeByID[id]; !ok {
			panel := afterByID[id]
			deltas = append(deltas, SceneDelta{
				Type:      DeltaPanelAdded,
				TowerName: towerName,
				Panel:     &panel,
			})
		}
	}

	// Updates: present in both, content changed.
	for _, id := range sortedPanelIDs(afterByID) {
		old, ok := beforeByID[id]
		if !ok {
			continue
		}
		now := afterByID[id]
		if old != now {
			panel := now
			deltas = append(deltas, SceneDelta{
				Type:      DeltaPanelUpdated,
				TowerName: towerName,
				Panel:     &panel,
			})
		}
	}

	return deltas
}

// towersByName indexes a Tower slice by Name (a Tower's identity, unique within
// a SceneState).
func towersByName(towers []Tower) map[string]Tower {
	byName := make(map[string]Tower, len(towers))
	for _, t := range towers {
		byName[t.Name] = t
	}
	return byName
}

// sortedTowerNames returns the map's Tower names in ascending order, so Diff
// emits deltas deterministically regardless of map iteration order.
func sortedTowerNames(byName map[string]Tower) []string {
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// panelID is a Panel's identity: the Pod's cluster-unique (Namespace, Pod) pair.
// It is a comparable struct so Panels can be indexed and compared by identity in
// a map.
type panelID struct {
	namespace string
	pod       string
}

// panelsByID indexes a Panel slice by its (Namespace, Pod) identity.
func panelsByID(panels []Panel) map[panelID]Panel {
	byID := make(map[panelID]Panel, len(panels))
	for _, p := range panels {
		byID[panelID{namespace: p.Namespace, pod: p.Pod}] = p
	}
	return byID
}

// sortedPanelIDs returns the map's Panel identities in ascending (Namespace,
// Pod) order — the same total order kube uses to nest Panels — so Panel deltas
// are emitted deterministically.
func sortedPanelIDs(byID map[panelID]Panel) []panelID {
	ids := make([]panelID, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if ids[i].namespace != ids[j].namespace {
			return ids[i].namespace < ids[j].namespace
		}
		return ids[i].pod < ids[j].pod
	})
	return ids
}
