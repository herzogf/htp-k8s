// Package server provides the HTTP server for the htp-k8s backend: it
// serves the embedded frontend build (see assets.go) and a WebSocket
// endpoint that streams the scene, plus a health check.
//
// This builds on the walking skeleton (ADR-0001). The WebSocket endpoint sends
// a SceneState snapshot on connect (issue #10) — the generated frontend wire
// contract defined in the scene package, carrying the View Mode from the startup
// permission probe (issue #9) and the current set of Towers (issue #12) — then,
// per ADR-0007, a stream of incremental Scene Deltas as the cluster changes
// (issue #16). A connection (or a reconnect) always starts with exactly one full
// snapshot, followed only by deltas.
package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// writeTimeout bounds a single WebSocket write. It stops a stuck or unresponsive
// client from blocking the per-connection delta pump indefinitely; a write that
// exceeds it fails the connection, which the client recovers from by reconnecting
// (and getting a fresh snapshot).
const writeTimeout = 10 * time.Second

// Config holds the runtime state the HTTP handler needs.
type Config struct {
	// Snapshot returns the SceneState to send to a client on connect. It is
	// called once per /ws connection (with the request's context) so each
	// client — and each reconnect — gets a fresh snapshot reflecting current
	// cluster state, rather than a value frozen at startup. It must not block
	// indefinitely; the request context bounds it. A nil Snapshot is treated
	// as an empty scene. Ignored when Subscribe is set.
	Snapshot func(ctx context.Context) scene.SceneState

	// Subscribe, when set, supersedes Snapshot and gives /ws the full
	// snapshot-then-deltas behaviour of ADR-0007. It is called once per
	// connection and returns, atomically, the initial SceneState snapshot to
	// send, a channel of Scene Deltas to stream after it (gap-free relative to
	// that snapshot), and an unsubscribe function the handler calls when the
	// connection ends. A closed delta channel signals the subscriber was dropped
	// (e.g. it fell too far behind); the handler then ends the connection so the
	// client reconnects for a fresh snapshot. Nil falls back to the
	// snapshot-only /ws using Snapshot.
	Subscribe func(ctx context.Context) (scene.SceneState, <-chan scene.SceneDelta, func())

	// TowerDetail returns the on-demand Detail Popup summary for one Tower by
	// name (issue #23), backing GET /api/towers/{name}. It is separate from the
	// /ws snapshot+delta stream on purpose: detail is fetched only when a user
	// clicks a Tower, so bundling it into every SceneState would bloat the
	// broadcast at scale (ADR-0007/ADR-0008). It is read-only (ADR-0003) and
	// degrades gracefully (ADR-0002) — a resource it can't fully read still
	// yields a usable detail. Nil disables the endpoint (503).
	TowerDetail func(ctx context.Context, name string) (scene.TowerDetail, error)

	// PodDetail returns the on-demand Detail Popup detail for one Pod (issue #23),
	// backing GET /api/pods/{namespace}/{name}. Read-only (ADR-0003). Nil
	// disables the endpoint (503).
	PodDetail func(ctx context.Context, namespace, name string) (scene.PodDetail, error)

	// PodLogTail streams a Pod's bounded live log tail (issue #23), backing the
	// SSE endpoint GET /api/pods/{namespace}/{name}/logtail. It drives emit with
	// each new tail window and blocks until the passed ctx is cancelled (the
	// client closing the stream) or the log stream ends; the handler cancels ctx
	// on client disconnect so it stops promptly. It is a small height-limited
	// tail, never a full log viewer or exec (ADR-0003). Nil disables the endpoint
	// (503).
	PodLogTail func(ctx context.Context, namespace, name string, emit func(scene.LogTail)) error

	// DemoSeed and DemoAutostart carry the backend-resolved Demo Mode startup
	// config (issue #91, ADR-0010), served verbatim at GET /api/config as
	// AppConfig (see config.go). DemoSeed is the seed for the frontend's
	// canyon-tour PRNG; DemoAutostart reports whether Demo Mode should start
	// automatically at launch. Both default to their zero values (seed 0,
	// autostart false) when unset, which is itself a well-formed response.
	DemoSeed      int64
	DemoAutostart bool

	// AllowedHosts is the Host-header allowlist enforced on /ws and /api by
	// hostAllowlist (issue #163 / ADR-0013), guarding against DNS rebinding —
	// a distinct threat from the Origin check above, since rebinding makes
	// Origin and Host both name the attacker's host, so same-origin alone
	// doesn't help. The zero value AllowedHosts{} trusts nothing with an
	// Origin header present, which would reject every browser request; callers
	// build this via server.NewAllowedHosts so loopback and the server's own
	// bind address are trusted without configuration.
	AllowedHosts AllowedHosts
}

// StaticSnapshot adapts a fixed SceneState into a Config.Snapshot function,
// for callers (and tests) that don't need per-connection refresh.
func StaticSnapshot(state scene.SceneState) func(context.Context) scene.SceneState {
	return func(context.Context) scene.SceneState { return state }
}

// upgrader upgrades HTTP connections to WebSocket connections for /ws.
//
// CheckOrigin is deliberately left unset (issue #163 / ADR-0013): gorilla's
// default (checkSameOrigin) already does the right thing — allow when no
// Origin header is present (non-browser clients: curl, other tooling, the
// e2e harness), otherwise require Origin to match the request Host. A prior
// version of this Upgrader set CheckOrigin to unconditionally return true,
// which let any website a browser visited read the live cluster topology
// over /ws; that override is gone, not replaced by a hand-rolled check, so
// this tracks gorilla's own (audited) behaviour. Same-origin alone does not
// stop DNS rebinding, though — see hostAllowlist below and ADR-0013 for the
// second, independent layer that closes that gap for /ws and /api both.
var upgrader = websocket.Upgrader{}

// NewHandler builds the HTTP handler for the htp-k8s backend: a health
// check at "/healthz", a WebSocket endpoint at "/ws" that sends the current
// SceneState then streams Scene Deltas, and the embedded frontend build served
// at "/".
func NewHandler(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	// /ws and every /api/* route are wrapped in the Host allowlist (issue #163
	// / ADR-0013) — the DNS-rebinding defense that a same-origin check alone
	// can't provide. /healthz and the static frontend at / carry no cluster
	// data, so they stay unwrapped.
	mux.Handle("GET /ws", hostAllowlist(cfg.AllowedHosts, newWSHandler(cfg)))
	// On-demand Detail Popup endpoints (issue #23). All read-only GETs — the
	// ServeMux rejects any other method with 405, so no mutating verb is reachable
	// on this data path (ADR-0003). The more specific /logtail pattern coexists
	// with the pod-detail pattern; Go's ServeMux routes the longer match first.
	mux.Handle("GET /api/towers/{name}", hostAllowlist(cfg.AllowedHosts, handleTowerDetail(cfg)))
	mux.Handle("GET /api/pods/{namespace}/{name}", hostAllowlist(cfg.AllowedHosts, handlePodDetail(cfg)))
	mux.Handle("GET /api/pods/{namespace}/{name}/logtail", hostAllowlist(cfg.AllowedHosts, handlePodLogTail(cfg)))
	// The frontend's startup-config channel (issue #91) — deliberately not on
	// SceneState (ADR-0008); see config.go.
	mux.Handle("GET /api/config", hostAllowlist(cfg.AllowedHosts, handleAppConfig(cfg)))
	mux.Handle("GET /", http.FileServerFS(frontendFS()))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// newWSHandler returns the /ws handler. On connect it upgrades the connection
// and sends exactly one full SceneState snapshot as a JSON text message. It then
// either streams Scene Deltas (when cfg.Subscribe is set, per ADR-0007) or, in
// the snapshot-only fallback, simply holds the connection open. Either way it
// keeps reading client frames so a client disconnect is noticed promptly.
func newWSHandler(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}
		defer conn.Close()

		snapshot, deltas, unsubscribe := subscribe(r.Context(), cfg)
		if unsubscribe != nil {
			defer unsubscribe()
		}

		if !writeJSON(conn, snapshot) {
			return
		}

		if deltas == nil {
			// Snapshot-only fallback: drain (and discard) client frames so the
			// connection stays open until the client disconnects.
			drainReads(conn)
			return
		}

		streamDeltas(conn, deltas)
	}
}

// subscribe resolves a connection's initial snapshot and, if configured, its
// delta stream. With cfg.Subscribe set it returns the snapshot, the delta
// channel, and the unsubscribe to run on disconnect. Otherwise it returns just
// the snapshot from cfg.Snapshot (a nil delta channel and unsubscribe), which
// selects the snapshot-only fallback. A wholly empty Config yields an empty scene.
func subscribe(ctx context.Context, cfg Config) (scene.SceneState, <-chan scene.SceneDelta, func()) {
	if cfg.Subscribe != nil {
		return cfg.Subscribe(ctx)
	}
	if cfg.Snapshot != nil {
		return cfg.Snapshot(ctx), nil, nil
	}
	return scene.SceneState{}, nil, nil
}

// streamDeltas pumps Scene Deltas to the client until the connection drops or
// the delta channel closes. A concurrent reader goroutine watches for the client
// going away (the only safe place to read, since gorilla forbids concurrent
// reads); this goroutine owns all writes. A closed delta channel (a dropped
// subscriber) ends the stream so the client reconnects for a fresh snapshot.
func streamDeltas(conn *websocket.Conn, deltas <-chan scene.SceneDelta) {
	clientGone := make(chan struct{})
	go func() {
		defer close(clientGone)
		drainReads(conn)
	}()

	for {
		select {
		case <-clientGone:
			return
		case delta, ok := <-deltas:
			if !ok {
				return
			}
			if !writeJSON(conn, delta) {
				return
			}
		}
	}
}

// writeJSON marshals v and writes it as one WebSocket text message under the
// write deadline, reporting success. A marshal error (unreachable for the
// fixed-shape wire types) or a write error is handled by ending the connection —
// the caller returns on false.
func writeJSON(conn *websocket.Conn, v any) bool {
	payload, err := json.Marshal(v)
	if err != nil {
		// Unreachable: the wire types are fixed-shape structs of JSON-safe
		// values. Log rather than crash the process.
		log.Printf("ws marshal %T: %v", v, err)
		return false
	}
	if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return false
	}
	return conn.WriteMessage(websocket.TextMessage, payload) == nil
}

// drainReads reads and discards client frames until the connection errors
// (typically the client disconnecting). It returns on the first read error.
func drainReads(conn *websocket.Conn) {
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
