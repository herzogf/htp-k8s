package server

import "net/http"

// This file holds the app-config startup endpoint (issue #91), kept separate
// from the on-demand Detail Popup endpoints (detail.go) and the /ws scene
// stream (server.go). It is deliberately not part of SceneState: SceneState is
// a cluster presentation view-model (ADR-0008), while AppConfig is app-level
// config the frontend needs once at bootstrap — a small seam reserved for
// future startup settings too.

// AppConfig is the JSON payload served at GET /api/config: the backend-resolved
// startup config Demo Mode's Canyon tour needs (ADR-0010), fetched once by the
// SPA at bootstrap.
type AppConfig struct {
	// DemoSeed is the seed for Demo Mode's canyon-tour PRNG, resolved on the
	// backend (-demo-seed / HTP_K8S_DEMO_SEED flag/env, or a random value if
	// neither is set — see cmd/htp-k8s) and always logged there. The frontend
	// seeds its tour RNG from this value so a given seed reproduces the same
	// tour (while the Tower arrangement is unchanged).
	DemoSeed int64 `json:"demoSeed"`
	// DemoAutostart reports whether Demo Mode should start automatically at
	// launch (-demo / HTP_K8S_DEMO flag/env), independent of DemoSeed — a seed
	// can be set without auto-starting the flight.
	DemoAutostart bool `json:"demoAutostart"`
}

// handleAppConfig serves GET /api/config: the backend-resolved startup config
// (AppConfig) taken verbatim from cfg. There is no failure mode — the zero
// value (seed 0, autostart false) is itself a well-formed response — so unlike
// the Detail Popup endpoints this handler is never disabled.
func handleAppConfig(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSONResponse(w, AppConfig{
			DemoSeed:      cfg.DemoSeed,
			DemoAutostart: cfg.DemoAutostart,
		})
	}
}
