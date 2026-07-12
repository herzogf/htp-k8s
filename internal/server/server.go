// Package server provides the HTTP server for the htp-k8s backend: it
// serves the embedded frontend build (see assets.go) and a WebSocket
// endpoint that streams the scene, plus a health check.
//
// This builds on the walking skeleton (ADR-0001). The WebSocket endpoint sends
// a SceneState snapshot on connect (issue #10) — the generated frontend wire
// contract defined in the scene package, currently carrying the View Mode from
// the startup permission probe (issue #9). Per ADR-0007 incremental Scene
// Deltas follow the snapshot; those are a later ticket.
package server

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// Config holds the runtime state the HTTP handler needs. It is built once at
// startup (after the permission probe) and is read-only thereafter.
type Config struct {
	// ViewMode is the View Mode detected at startup by the permission probe
	// (see kube.DetectViewMode), carried in the SceneState sent over /ws.
	ViewMode scene.ViewMode
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
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /ws", newWSHandler(scene.SceneState{ViewMode: cfg.ViewMode}))
	mux.Handle("GET /", http.FileServerFS(frontendFS()))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// newWSHandler returns the /ws handler. On connect it upgrades the
// connection, sends the SceneState snapshot once as a JSON text message, then
// drains (and discards) any client frames so the connection stays open until
// the client disconnects. Per ADR-0007 incremental Scene Deltas would follow
// this snapshot; that streaming is a later ticket.
func newWSHandler(state scene.SceneState) http.HandlerFunc {
	payload, err := json.Marshal(state)
	if err != nil {
		// Unreachable: SceneState is a fixed-shape struct of strings.
		panic(err)
	}

	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}
		defer conn.Close()

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
