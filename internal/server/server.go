// Package server provides the minimal HTTP server for the htp-k8s backend.
//
// This is prefactoring for later tickets: it establishes the shape (a
// configurable HTTP server exposing a health check) that real Kubernetes
// connectivity and scene-delta streaming will build on. It has no cluster
// connectivity of its own yet.
package server

import (
	"encoding/json"
	"net/http"
)

// rootResponse is the hardcoded placeholder body served at "/" until a
// later ticket wires in real cluster-derived scene state.
type rootResponse struct {
	Message string `json:"message"`
}

// NewHandler builds the HTTP handler for the htp-k8s backend: a health
// check at "/healthz" and a hardcoded placeholder response at "/".
func NewHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /{$}", handleRoot)
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(rootResponse{
		Message: "htp-k8s backend placeholder - no cluster connectivity yet",
	})
}
