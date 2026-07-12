// Package server provides the HTTP server for the htp-k8s backend: it
// serves the embedded frontend build (see assets.go) and a WebSocket
// endpoint that reports the detected View Mode, plus a health check.
//
// This builds on the walking skeleton (ADR-0001). The WebSocket endpoint now
// sends a minimal view-mode message derived from the startup permission probe
// (issue #9); the full SceneState/SceneDelta wire contract is a later ticket
// (#10) built on this same shape.
package server

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/kube"
)

// Config holds the runtime state the HTTP handler needs. It is built once at
// startup (after the permission probe) and is read-only thereafter.
type Config struct {
	// ViewMode is the View Mode detected at startup by the permission probe
	// (see kube.DetectViewMode), reported to clients over /ws.
	ViewMode kube.ViewMode
}

// messageTypeViewMode tags the /ws message that carries the current View
// Mode. Naming a message type now keeps room for the SceneState/SceneDelta
// message types added in issue #10 on the same connection.
const messageTypeViewMode = "viewMode"

// viewModeMessage is the minimal /ws payload conveying the detected View
// Mode. It is deliberately small: the full SceneState contract lands in #10.
type viewModeMessage struct {
	Type     string        `json:"type"`
	ViewMode kube.ViewMode `json:"viewMode"`
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
// check at "/healthz", a WebSocket endpoint at "/ws" that reports the
// detected View Mode, and the embedded frontend build served at "/".
func NewHandler(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /ws", newWSHandler(cfg.ViewMode))
	mux.Handle("GET /", http.FileServerFS(frontendFS()))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// newWSHandler returns the /ws handler. On connect it upgrades the
// connection, sends the current View Mode once as a JSON text message, then
// drains (and discards) any client frames so the connection stays open until
// the client disconnects.
func newWSHandler(mode kube.ViewMode) http.HandlerFunc {
	payload, err := json.Marshal(viewModeMessage{Type: messageTypeViewMode, ViewMode: mode})
	if err != nil {
		// Unreachable: the message is a fixed-shape struct of strings.
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
