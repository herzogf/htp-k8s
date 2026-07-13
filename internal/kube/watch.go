package kube

import (
	"context"
	"log"
	"sync"
	"time"

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
// snapshot is unaffected. (The OpenShift Project-fallback resource is not watched
// for deltas; a new Project appears only on the next snapshot/reconnect — the
// watch-side analogue of BuildPanels' deferred Project fallback, issue #55.)
type SceneWatcher struct {
	rebuild func(context.Context) scene.SceneState
	factory informers.SharedInformerFactory
	// informers are the mode-scoped shared informers this watcher drives its
	// rebuilds from; retained so Start can register handlers and wait for their
	// caches to sync.
	informers []cache.SharedIndexInformer

	// trigger is a one-slot coalescing signal: an informer event does a
	// non-blocking send, so many events between two rebuilds collapse into a
	// single pending rebuild.
	trigger chan struct{}

	mu          sync.Mutex
	current     scene.SceneState
	subscribers map[int]chan scene.SceneDelta
	nextID      int
	started     bool
}

// NewSceneWatcher builds a SceneWatcher for the given View Mode over the given
// clients. It does not touch the cluster or start any watches until Start is
// called. The dynamic client is currently unused by the watch set (see the type
// doc's Project-fallback note) but is accepted so the rebuild path matches
// BuildScene exactly and so adding a Project informer later needs no signature
// change.
func NewSceneWatcher(client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode) *SceneWatcher {
	rebuild := func(ctx context.Context) scene.SceneState {
		ctx, cancel := context.WithTimeout(ctx, rebuildTimeout)
		defer cancel()
		return BuildScene(ctx, client, dyn, mode)
	}

	factory := informers.NewSharedInformerFactory(client, 0)
	// Pods drive Panel deltas in every mode; the Tower source resource depends
	// on the mode (Nodes vs Namespaces), matching BuildTowers' scoping.
	infs := []cache.SharedIndexInformer{factory.Core().V1().Pods().Informer()}
	switch mode {
	case scene.ViewModeNode:
		infs = append(infs, factory.Core().V1().Nodes().Informer())
	default:
		infs = append(infs, factory.Core().V1().Namespaces().Informer())
	}

	return &SceneWatcher{
		rebuild:     rebuild,
		factory:     factory,
		informers:   infs,
		trigger:     make(chan struct{}, 1),
		subscribers: map[int]chan scene.SceneDelta{},
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
	// event just pokes the coalescing trigger.
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

	// Seed current before any diffing so the objects present at startup are the
	// baseline, not a flood of spurious "added" deltas. The handlers registered
	// above fire for those same objects during the initial sync below, but each
	// resulting rebuild diffs equal against this seed, so nothing is emitted.
	// Rebuild outside the lock (it lists the API), then assign under it so the
	// seed is visible to any subscriber with the same happens-before the worker
	// relies on.
	seed := w.rebuild(ctx)
	w.mu.Lock()
	w.current = seed
	w.mu.Unlock()

	w.factory.Start(ctx.Done())
	w.factory.WaitForCacheSync(ctx.Done())

	go w.run(ctx)
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
	w.current = next

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
