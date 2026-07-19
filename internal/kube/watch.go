package kube

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// rebuildTimeout bounds a single SceneState rebuild (the LISTs behind
// BuildScene) so a slow API server can't stall the watcher's worker loop.
const rebuildTimeout = 10 * time.Second

// subscriberBuffer is the per-subscriber delta channel capacity. It absorbs a
// burst of deltas without blocking the watcher's single worker. A subscriber
// that can't keep up and overruns it is dropped (its channel closed), which ends
// its /ws connection and prompts a reconnect for a fresh snapshot — the same
// "resync from a new LIST" recovery Kubernetes' own watch clients use when they
// fall too far behind, and far safer than unbounded buffering.
const subscriberBuffer = 256

// blinkDebounce coalesces a burst of blink-worthy activity on a single Panel
// into one blink: a Panel that just blinked won't blink again until this window
// elapses. It exists because blinks are emitted straight off the informer
// stream (not through the rebuild trigger's coalescing), so a pod flapping —
// restarting in a tight loop, or drawing a storm of Events — would otherwise
// emit a blink per event. One pulse per Panel per window is plenty for the
// frontend's one-shot animation, and keeps a misbehaving pod from flooding the
// delta stream. It is deliberately short so distinct activity a moment apart
// still reads as separate blinks.
const blinkDebounce = 500 * time.Millisecond

// SceneWatcher turns a cluster's live changes into a current SceneState plus a
// stream of scene.SceneDeltas, implementing ADR-0007's "k8s watch events in →
// Scene Deltas out" for the server: a client subscribes, receives the current
// SceneState snapshot, then only the deltas that follow.
//
// It is a rebuild-and-diff watcher rather than an event-by-event translator: any
// relevant informer event (a Node/Namespace/Pod add, update, or delete) triggers
// a full SceneState rebuild via BuildScene, which is then diffed against the last
// state (scene.Diff) to yield the minimal deltas. This reuses the exact snapshot
// path — so deltas and snapshots can't drift — and is self-correcting: coalesced
// or missed events still converge because every rebuild reconciles against real
// cluster state. Informer events are coalesced through a one-slot trigger, so a
// storm of changes collapses into as few rebuilds as the worker can service.
//
// The watch set is scoped to the View Mode, mirroring BuildTowers/BuildPanels
// (Nodes + Pods in Node-mode, Namespaces + Pods in Namespace-mode), so it never
// requests more than the mode already reads. Per ADR-0002 a forbidden or absent
// resource degrades gracefully: an informer that cannot watch simply delivers no
// events (its errors are logged by client-go), pods still flow, and the initial
// snapshot is unaffected.
//
// Neither the OpenShift Project-fallback resource nor a per-Project-scoped Pods
// list is ever watched for deltas — every informer here is cluster-scoped. For a
// project-scoped OpenShift user (issue #55's target), that means every one of
// these informers 403s the same way the old cluster-wide BuildPanels call did,
// so no event ever fires and the coalescing trigger (notify/run below) is never
// poked. SnapshotAndSubscribe hands a new subscriber the cached current
// SceneState under lock — it does NOT call BuildScene — so current stays
// exactly what the single rebuild in Start produced before the informers were
// even started, for as long as the watcher runs. A reconnect does not "re-run
// the fallback": it receives that same frozen snapshot, not a fresh one. (A
// separate, more fundamental gap — whether Start can even return for such a
// user when WaitForCacheSync never completes — is tracked outside this
// comment, not yet fixed.)
type SceneWatcher struct {
	rebuild func(context.Context) scene.SceneState
	factory informers.SharedInformerFactory
	// informers are the mode-scoped shared informers this watcher drives its
	// rebuilds from; retained so Start can register handlers and wait for their
	// caches to sync.
	informers []cache.SharedIndexInformer
	// podsInformer is the Pod informer (also one of informers). Retained
	// separately so Start can hang the blink activity detector off pod updates —
	// where an old/new pod pair, and so a phase transition or restart-count
	// increase, is directly visible (unlike the rebuild-and-diff path).
	podsInformer cache.SharedIndexInformer
	// eventsInformer watches the namespaced Events API for blink-worthy new
	// Events about pods (issue #18). It is NOT one of informers: an Event never
	// changes the SceneState, so it must not trigger a rebuild — it only feeds
	// blink detection. Events are readable with default cluster read permissions
	// (ADR-0002); if the watch is forbidden the informer simply delivers nothing.
	eventsInformer cache.SharedIndexInformer

	// trigger is a one-slot coalescing signal: an informer event does a
	// non-blocking send, so many events between two rebuilds collapse into a
	// single pending rebuild.
	trigger chan struct{}

	// synced gates event-driven blinks until the initial caches have synced, so
	// the flood of pre-existing Events replayed during the initial LIST doesn't
	// fire a startup blink storm — only Events arriving after sync are activity.
	synced atomic.Bool

	mu          sync.Mutex
	current     scene.SceneState
	subscribers map[int]chan scene.SceneDelta
	nextID      int
	started     bool
	// panelTower maps each Panel currently in the scene (by pod identity) to its
	// Tower's name — the blink homing index, rebuilt whenever current advances.
	// A blink is emitted only for a pod found here, so it always names a Panel
	// the frontend holds and respects the same View-Mode homing and Namespace
	// Filter the built scene already applied.
	panelTower map[panelKey]string
	// lastBlink records when each Panel last blinked, for the blinkDebounce
	// coalescing. Kept small by pruning entries older than the window on use.
	lastBlink map[panelKey]time.Time
}

// NewSceneWatcher builds a SceneWatcher for the given View Mode over the given
// clients. It does not touch the cluster or start any watches until Start is
// called. The dynamic client is currently unused by the watch set (see the type
// doc's Project-fallback note) but is accepted so the rebuild path matches
// BuildScene exactly and so adding a Project informer later needs no signature
// change.
//
// The NamespaceFilter is the startup preset (see NamespaceFilter): it is baked
// into the rebuild closure so every snapshot and every diffed Scene Delta is
// filtered identically — the filtered scene is simply the scene, so deltas
// never reveal a Namespace/Project the snapshot hid.
func NewSceneWatcher(client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode, filter NamespaceFilter) *SceneWatcher {
	rebuild := func(ctx context.Context) scene.SceneState {
		ctx, cancel := context.WithTimeout(ctx, rebuildTimeout)
		defer cancel()
		return BuildScene(ctx, client, dyn, mode, filter)
	}

	factory := informers.NewSharedInformerFactory(client, 0)
	// Pods drive Panel deltas in every mode; the Tower source resource depends
	// on the mode (Nodes vs Namespaces), matching BuildTowers' scoping.
	podsInformer := factory.Core().V1().Pods().Informer()
	infs := []cache.SharedIndexInformer{podsInformer}
	switch mode {
	case scene.ViewModeNode:
		infs = append(infs, factory.Core().V1().Nodes().Informer())
	default:
		infs = append(infs, factory.Core().V1().Namespaces().Informer())
	}

	// The Events informer feeds blink detection only (it never triggers a
	// rebuild), so it is created here but kept out of the rebuild informer set.
	// Requesting it from the factory ensures factory.Start also starts it.
	eventsInformer := factory.Core().V1().Events().Informer()

	return &SceneWatcher{
		rebuild:        rebuild,
		factory:        factory,
		informers:      infs,
		podsInformer:   podsInformer,
		eventsInformer: eventsInformer,
		trigger:        make(chan struct{}, 1),
		subscribers:    map[int]chan scene.SceneDelta{},
		panelTower:     map[panelKey]string{},
		lastBlink:      map[panelKey]time.Time{},
	}
}

// Start establishes the watch: it registers change handlers, seeds the current
// SceneState with an initial rebuild, starts the informers and waits for their
// caches to sync, then runs the worker loop that rebuilds-and-broadcasts on each
// coalesced trigger. It returns once the watcher is live (caches synced); the
// watch runs until ctx is cancelled, at which point the worker and informers
// stop and every subscriber channel is closed. A second call is a guarded no-op.
func (w *SceneWatcher) Start(ctx context.Context) {
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return
	}
	w.started = true
	w.mu.Unlock()

	// Register handlers before starting the factory so no event is missed; each
	// rebuild-driving event just pokes the coalescing trigger.
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { w.notify() },
		UpdateFunc: func(any, any) { w.notify() },
		DeleteFunc: func(any) { w.notify() },
	}
	for _, inf := range w.informers {
		if _, err := inf.AddEventHandler(handler); err != nil {
			log.Printf("scene watcher: add event handler: %v", err)
		}
	}

	// Blink detection runs alongside the rebuild trigger, off the raw informer
	// stream where the activity is directly visible: a pod update carries the
	// old/new pair (a phase transition or restart-count increase), and an Event
	// add is itself the activity. Both are emitted out-of-band as transient blink
	// deltas rather than through the rebuild-and-diff (which can't see them).
	if _, err := w.podsInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		UpdateFunc: w.onPodUpdate,
	}); err != nil {
		log.Printf("scene watcher: add pod blink handler: %v", err)
	}
	if _, err := w.eventsInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    w.onEventAdd,
		UpdateFunc: w.onEventUpdate,
	}); err != nil {
		log.Printf("scene watcher: add event blink handler: %v", err)
	}

	// Seed current before any diffing so the objects present at startup are the
	// baseline, not a flood of spurious "added" deltas. The handlers registered
	// above fire for those same objects during the initial sync below, but each
	// resulting rebuild diffs equal against this seed, so nothing is emitted.
	// Rebuild outside the lock (it lists the API), then assign under it so the
	// seed is visible to any subscriber with the same happens-before the worker
	// relies on. Seed the blink homing index from the same scene.
	seed := w.rebuild(ctx)
	w.mu.Lock()
	w.current = seed
	w.panelTower = indexPanelTowers(seed)
	w.mu.Unlock()

	w.factory.Start(ctx.Done())
	w.factory.WaitForCacheSync(ctx.Done())

	// Caches are synced: the pre-existing Events have all been replayed (and
	// suppressed) through onEventAdd, so from here a new Event is genuine
	// activity and may blink.
	w.synced.Store(true)

	go w.run(ctx)
}

// onPodUpdate is the pod-informer blink handler: it maps a pod's old→new
// transition to blink-worthy activity (a phase change or a restart) and, when
// there is any, emits a blink for that pod's Panel.
func (w *SceneWatcher) onPodUpdate(oldObj, newObj any) {
	oldPod, ok := oldObj.(*corev1.Pod)
	if !ok {
		return
	}
	newPod, ok := newObj.(*corev1.Pod)
	if !ok {
		return
	}
	if activity, ok := podBlinkActivity(oldPod, newPod); ok {
		w.emitBlink(newPod.Namespace, newPod.Name, activity)
	}
}

// onEventAdd is the events-informer add handler: a brand-new Kubernetes Event
// about a pod is blink-worthy activity on that pod's Panel. It is gated on synced
// so the initial replay of existing Events can't fire a startup storm.
func (w *SceneWatcher) onEventAdd(obj any) {
	if !w.synced.Load() {
		return
	}
	if event, ok := obj.(*corev1.Event); ok {
		w.blinkForPodEvent(event)
	}
}

// onEventUpdate is the events-informer update handler: it blinks on a *recurrence*
// of an Event, not on every update. Kubernetes' EventRecorder aggregates repeated
// occurrences of the same event by incrementing the existing Event's Count (and
// advancing its timestamps) rather than creating a new object, so a pod that keeps
// hitting the same condition (e.g. repeated BackOff) surfaces as Count-bumping
// updates. A rising Count is a fresh occurrence — real activity — while any other
// update (a resourceVersion touch, a relist delivering an unchanged Event) is not.
func (w *SceneWatcher) onEventUpdate(oldObj, newObj any) {
	if !w.synced.Load() {
		return
	}
	oldEvent, ok := oldObj.(*corev1.Event)
	if !ok {
		return
	}
	newEvent, ok := newObj.(*corev1.Event)
	if !ok {
		return
	}
	if newEvent.Count > oldEvent.Count {
		w.blinkForPodEvent(newEvent)
	}
}

// blinkForPodEvent emits an event blink for the pod an Event involves, if it
// involves a pod at all. It matches the Event's involved object to a pod the same
// way the Detail Popup's event listing does (InvolvedObject Kind=Pod with a
// name); emitBlink then homes it to the pod's Panel (or drops it if there is none).
func (w *SceneWatcher) blinkForPodEvent(event *corev1.Event) {
	ref := event.InvolvedObject
	if ref.Kind != "Pod" || ref.Name == "" {
		return
	}
	w.emitBlink(ref.Namespace, ref.Name, scene.ActivityEvent)
}

// SnapshotAndSubscribe atomically captures the current SceneState and registers
// a new subscriber, returning the snapshot, a channel that will receive every
// SceneDelta emitted after that snapshot, and an unsubscribe function. Capturing
// the snapshot and registering under the same lock the broadcaster holds
// guarantees the stream is gap-free and duplicate-free: the returned snapshot
// plus the channel's deltas always reconstruct the live scene.
//
// The caller must call unsubscribe when done (e.g. on /ws disconnect) to release
// the subscriber. The channel is closed either by unsubscribe or by the watcher
// dropping a subscriber that overran its buffer (see subscriberBuffer); a closed
// channel signals the consumer to stop and reconnect for a fresh snapshot.
func (w *SceneWatcher) SnapshotAndSubscribe() (scene.SceneState, <-chan scene.SceneDelta, func()) {
	w.mu.Lock()
	defer w.mu.Unlock()

	id := w.nextID
	w.nextID++
	ch := make(chan scene.SceneDelta, subscriberBuffer)
	w.subscribers[id] = ch

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			if existing, ok := w.subscribers[id]; ok {
				delete(w.subscribers, id)
				close(existing)
			}
		})
	}

	return w.current, ch, unsubscribe
}

// TowerCount returns the number of Towers in the current SceneState. It backs
// the startup "demo seed: <n> (tower count: <n>)" log line (see cmd/htp-k8s):
// Demo Mode's Canyon tour (ADR-0010) is a function of the seed and the Tower
// arrangement, so the count at startup is half of the tour's reproduction key.
func (w *SceneWatcher) TowerCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.current.Towers)
}

// notify pokes the coalescing trigger without blocking: if a rebuild is already
// pending the poke is dropped, so bursts of events cost at most one extra rebuild.
func (w *SceneWatcher) notify() {
	select {
	case w.trigger <- struct{}{}:
	default:
	}
}

// run is the worker loop: on each coalesced trigger it rebuilds the SceneState,
// diffs it against current, and broadcasts the deltas. It is the only goroutine
// that rebuilds, so rebuilds are serialized and deltas are broadcast in order.
func (w *SceneWatcher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			w.closeAll()
			return
		case <-w.trigger:
			w.rebuildAndBroadcast(ctx)
		}
	}
}

// rebuildAndBroadcast rebuilds the SceneState (outside the lock, as it lists the
// API), then under the lock diffs it against current, advances current, and
// fans the deltas out to subscribers. A subscriber whose buffer is full is
// dropped: its channel is closed and it is removed, ending its connection so it
// reconnects for a fresh snapshot.
func (w *SceneWatcher) rebuildAndBroadcast(ctx context.Context) {
	next := w.rebuild(ctx)

	w.mu.Lock()
	defer w.mu.Unlock()

	deltas := scene.Diff(w.current, next)
	if len(deltas) == 0 {
		return
	}
	if before, after := len(w.current.Towers), len(next.Towers); before != after {
		// Demo Mode's Canyon graph (ADR-0010) is derived from the Tower
		// arrangement, so a count change is exactly what can diverge a seed's
		// reproduction after the fact — logged as the "why did the same seed
		// fly differently later" answer, alongside the seed+count startup line.
		log.Printf("tower count changed: %d -> %d", before, after)
	}
	w.current = next
	// Refresh the blink homing index so later blinks resolve against the new
	// set of Panels (re-homed, added, or removed pods).
	w.panelTower = indexPanelTowers(next)

	w.broadcastLocked(deltas)
}

// emitBlink emits a transient DeltaPanelBlink for the pod's Panel, if that Panel
// is currently in the scene and hasn't blinked within blinkDebounce. Homing,
// filtering, and existence are all resolved through panelTower (the built
// scene), so a blink is never emitted for a pod the frontend has no Panel for
// (unscheduled in Node-mode, hidden by the Namespace Filter, or already gone) —
// no need to re-derive View-Mode homing or re-apply the filter here.
func (w *SceneWatcher) emitBlink(namespace, pod string, activity scene.PanelActivity) {
	key := panelKey{namespace: namespace, pod: pod}

	w.mu.Lock()
	defer w.mu.Unlock()

	tower, ok := w.panelTower[key]
	if !ok {
		// No Panel for this pod in the current scene — nothing to blink.
		return
	}

	now := time.Now()
	w.pruneBlinkLocked(now)
	if last, seen := w.lastBlink[key]; seen && now.Sub(last) < blinkDebounce {
		// Coalesced: this Panel already blinked within the window.
		return
	}
	w.lastBlink[key] = now

	w.broadcastLocked([]scene.SceneDelta{{
		Type:      scene.DeltaPanelBlink,
		TowerName: tower,
		Namespace: namespace,
		Pod:       pod,
		Activity:  activity,
	}})
}

// pruneBlinkLocked drops lastBlink entries older than the debounce window,
// bounding the map to Panels that blinked within the last window regardless of
// how many distinct pods have churned through the cluster. Called under mu.
func (w *SceneWatcher) pruneBlinkLocked(now time.Time) {
	for key, last := range w.lastBlink {
		if now.Sub(last) >= blinkDebounce {
			delete(w.lastBlink, key)
		}
	}
}

// broadcastLocked fans deltas out to every subscriber in order, dropping any
// whose buffer overran (its channel is closed and it is removed, ending its
// connection so it reconnects for a fresh snapshot). It must be called with mu
// held; both the rebuild worker and the blink handlers broadcast through it, so
// the mutex serializes their fan-out and keeps each subscriber's stream ordered.
func (w *SceneWatcher) broadcastLocked(deltas []scene.SceneDelta) {
	for id, ch := range w.subscribers {
		if !trySendAll(ch, deltas) {
			delete(w.subscribers, id)
			close(ch)
		}
	}
}

// trySendAll non-blockingly sends every delta to ch in order, reporting whether
// all fit. A false means the subscriber's buffer overran mid-batch; the caller
// drops it rather than blocking the worker on one slow consumer.
func trySendAll(ch chan scene.SceneDelta, deltas []scene.SceneDelta) bool {
	for _, d := range deltas {
		select {
		case ch <- d:
		default:
			return false
		}
	}
	return true
}

// closeAll closes and removes every subscriber channel, run on shutdown so
// consumers unblock and see the stream end.
func (w *SceneWatcher) closeAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for id, ch := range w.subscribers {
		delete(w.subscribers, id)
		close(ch)
	}
}
