// Package server provides the HTTP server for the htp-k8s backend: it
// serves the embedded frontend build (see assets.go) and a placeholder
// WebSocket endpoint, plus a health check.
//
// This is the walking skeleton (ADR-0001): the WebSocket endpoint sends a
// single hardcoded placeholder message and has no cluster connectivity of
// its own yet. Real Kubernetes connectivity and Scene State/Scene Delta
// streaming are built on this shape in later tickets.
package server

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

// placeholderMessage is the hardcoded text sent to every client that
// connects to /ws, until a later ticket replaces it with real
// cluster-derived Scene State.
const placeholderMessage = "htp-k8s backend placeholder - no cluster connectivity yet"

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
// check at "/healthz", a placeholder WebSocket endpoint at "/ws", and the
// embedded frontend build served at "/".
func NewHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /ws", handleWS)
	mux.Handle("GET /", http.FileServerFS(frontendFS()))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// handleWS upgrades the connection and sends the hardcoded placeholder
// message once, then drains (and discards) any client frames so the
// connection stays open until the client disconnects.
func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte(placeholderMessage)); err != nil {
		return
	}

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
