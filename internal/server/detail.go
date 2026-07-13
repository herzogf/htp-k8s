package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// This file holds the on-demand Detail Popup HTTP endpoints (issue #23), kept
// separate from the /ws scene stream (server.go). The split is deliberate: the
// /ws endpoint is ADR-0007's one-way snapshot+delta broadcast, whereas detail is
// pulled only when a user clicks a Tower or Panel. Serving detail on its own
// lightweight read-only GET/SSE endpoints — rather than multiplexing
// request/response over the delta stream (which owns all writes on one goroutine
// and carries no correlation machinery) — keeps both surfaces simple and keeps
// per-click detail out of the broadcast so SceneState stays lean at scale
// (ADR-0008). Every endpoint here is read-only (ADR-0003).

// handleTowerDetail serves GET /api/towers/{name}: the on-demand summary for one
// Tower. Per ADR-0002 the detail degrades gracefully — the provider returns a
// usable TowerDetail (at least Name+Kind) even when the backing resource can't be
// fully read — so a non-nil provider error is logged, not surfaced as an HTTP
// error, and the well-formed (possibly partial) detail is still returned.
func handleTowerDetail(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.TowerDetail == nil {
			http.Error(w, "tower detail not available", http.StatusServiceUnavailable)
			return
		}
		name := r.PathValue("name")
		if name == "" {
			http.Error(w, "tower name is required", http.StatusBadRequest)
			return
		}

		detail, err := cfg.TowerDetail(r.Context(), name)
		if err != nil {
			// Graceful degradation (ADR-0002): the detail is still usable.
			log.Printf("tower detail %q: %v", name, err)
		}
		writeJSONResponse(w, detail)
	}
}

// handlePodDetail serves GET /api/pods/{namespace}/{name}: the static detail for
// one Pod. Unlike tower detail, a provider error here means the pod couldn't be
// read at all (the realistic case is a pod deleted between the click and the
// fetch), so it maps to 404 — the pod is simply no longer there to show.
func handlePodDetail(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.PodDetail == nil {
			http.Error(w, "pod detail not available", http.StatusServiceUnavailable)
			return
		}
		namespace, name := r.PathValue("namespace"), r.PathValue("name")
		if namespace == "" || name == "" {
			http.Error(w, "pod namespace and name are required", http.StatusBadRequest)
			return
		}

		detail, err := cfg.PodDetail(r.Context(), namespace, name)
		if err != nil {
			log.Printf("pod detail %s/%s: %v", namespace, name, err)
			http.Error(w, "pod not found", http.StatusNotFound)
			return
		}
		writeJSONResponse(w, detail)
	}
}

// handlePodLogTail serves GET /api/pods/{namespace}/{name}/logtail as a
// Server-Sent Events stream of the pod's bounded live log tail. SSE is chosen
// over WebSocket precisely because it is one-directional server→client: the
// client cannot send anything back, which structurally matches the read-only,
// tail-only contract (ADR-0003) — there is no channel to smuggle an exec or a
// "fetch more history" request through. Each event's data is a JSON scene.LogTail
// (the current ≤ LogTailMaxLines window). The stream stops when the client
// disconnects: that cancels the request context, which the provider observes to
// stop the underlying Kubernetes log stream, so nothing is left following.
func handlePodLogTail(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.PodLogTail == nil {
			http.Error(w, "pod log tail not available", http.StatusServiceUnavailable)
			return
		}
		namespace, name := r.PathValue("namespace"), r.PathValue("name")
		if namespace == "" || name == "" {
			http.Error(w, "pod namespace and name are required", http.StatusBadRequest)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			// Without flushing we can't stream events incrementally.
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// emit runs synchronously inside PodLogTail on this one goroutine, so the
		// single ResponseWriter is never written concurrently. A write error means
		// the client is gone; the request context cancellation (below/observed by
		// the provider) is what actually stops the stream.
		emit := func(tail scene.LogTail) {
			payload, err := json.Marshal(tail)
			if err != nil {
				return
			}
			// SSE frame: a single data: line terminated by a blank line.
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		}

		if err := cfg.PodLogTail(r.Context(), namespace, name, emit); err != nil {
			// The client disconnecting is the normal end of a tail; only log
			// anything unexpected. The response is already committed (200 + SSE),
			// so there's nothing to send but a log line.
			log.Printf("pod log tail %s/%s: %v", namespace, name, err)
		}
	}
}

// writeJSONResponse marshals v to the response as JSON. A marshal failure on
// these fixed-shape wire types is unreachable in practice; it is logged and a 500
// returned rather than crashing the process.
func writeJSONResponse(w http.ResponseWriter, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		log.Printf("detail marshal %T: %v", v, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(payload)
}
