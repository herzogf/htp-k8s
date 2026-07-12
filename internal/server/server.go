// Package server provides the HTTP server for the htp-k8s backend: it
// serves the embedded frontend build (see assets.go) and a WebSocket
// endpoint that streams the scene, plus a health check.
//
// This builds on the walking skeleton (ADR-0001). The WebSocket endpoint sends
// a SceneState snapshot on connect (issue #10) — the generated frontend wire
// contract defined in the scene package, carrying the View Mode from the
// startup permission probe (issue #9) and the current set of Towers (issue
// #12). The snapshot is produced fresh per connection by Config.Snapshot, so a
// client (or a reconnect) always sees current cluster state. Per ADR-0007
// incremental Scene Deltas follow the snapshot; those are a later ticket.
package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// Config holds the runtime state the HTTP handler needs.
type Config struct {
	// Snapshot returns the SceneState to send to a client on connect. It is
	// called once per /ws connection (with the request's context) so each
	// client — and each reconnect — gets a fresh snapshot reflecting current
	// cluster state, rather than a value frozen at startup. It must not block
	// indefinitely; the request context bounds it. A nil Snapshot is treated
	// as an empty scene.
	Snapshot func(ctx context.Context) scene.SceneState
}

// StaticSnapshot adapts a fixed SceneState into a Config.Snapshot function,
// for callers (and tests) that don't need per-connection refresh.
func StaticSnapshot(state scene.SceneState) func(context.Context) scene.SceneState {
	return func(context.Context) scene.SceneState { return state }
}

// upgrader upgrades HTTP connections to WebSocket connections for /ws.
//
// CheckOrigin allows all origins: /ws has no auth/session state yet, and
// the frontend dev server (Vite, on its own port) needs to reach the
// backend across origins during local development. Revisit if/when this
// endpoint carries anything sensitive.
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// NewHandler builds the HTTP handler for the htp-k8s backend: a health
// check at "/healthz", a WebSocket endpoint at "/ws" that sends the current
// SceneState, and the embedded frontend build served at "/".
func NewHandler(cfg Config) http.Handler {
	snapshot := cfg.Snapshot
	if snapshot == nil {
		snapshot = StaticSnapshot(scene.SceneState{})
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /ws", newWSHandler(snapshot))
	mux.Handle("GET /", http.FileServerFS(frontendFS()))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// newWSHandler returns the /ws handler. On connect it upgrades the connection,
// builds a fresh SceneState snapshot (via snapshot), sends it once as a JSON
// text message, then drains (and discards) any client frames so the connection
// stays open until the client disconnects. Per ADR-0007 incremental Scene
// Deltas would follow this snapshot; that streaming is a later ticket.
func newWSHandler(snapshot func(ctx context.Context) scene.SceneState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}
		defer conn.Close()

		payload, err := json.Marshal(snapshot(r.Context()))
		if err != nil {
			// Unreachable: SceneState is a fixed-shape struct of
			// JSON-safe values. Log rather than crash the process.
			log.Printf("ws marshal SceneState: %v", err)
			return
		}

		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			return
		}

		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}
