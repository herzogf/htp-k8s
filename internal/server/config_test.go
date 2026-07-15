package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/herzogf/htp-k8s/internal/server"
)

// TestAppConfig_ReturnsSeedAndAutostart proves GET /api/config carries the
// backend-resolved Demo Mode startup config (issue #91) verbatim as JSON.
func TestAppConfig_ReturnsSeedAndAutostart(t *testing.T) {
	cfg := server.Config{DemoSeed: 42, DemoAutostart: true}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}

	var got server.AppConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (body %q)", err, rec.Body.String())
	}
	if got.DemoSeed != 42 || !got.DemoAutostart {
		t.Fatalf("got %+v, want {DemoSeed:42 DemoAutostart:true}", got)
	}
}

// TestAppConfig_DefaultsToZeroValue proves an unconfigured server (no seed/
// autostart set) still serves a well-formed AppConfig rather than erroring —
// there is no "not available" state for this endpoint, unlike the on-demand
// Detail Popup endpoints.
func TestAppConfig_DefaultsToZeroValue(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	server.NewHandler(server.Config{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got server.AppConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (body %q)", err, rec.Body.String())
	}
	if got.DemoSeed != 0 || got.DemoAutostart {
		t.Fatalf("got %+v, want the zero value", got)
	}
}

// TestAppConfig_MethodNotAllowed proves only GET is registered — mirrors the
// other endpoints' ServeMux-enforced read-only surface (ADR-0003).
func TestAppConfig_MethodNotAllowed(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/config", nil)
	server.NewHandler(server.Config{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}
