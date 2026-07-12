package server_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/server"
)

// testConfig is a server.Config with an explicit View Mode, used by tests
// that don't care about the mode itself.
var testConfig = server.Config{ViewMode: kube.ViewModeNamespace}

func TestHealthz_OK(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "ok" {
		t.Fatalf("body = %q, want %q", got, "ok")
	}
}

func TestHealthz_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

// TestRoot_ServesEmbeddedFrontend exercises the embedded frontend build
// (internal/server/dist, see assets.go) served at "/". It doesn't assert on
// exact body content: dist/ holds either the checked-in placeholder
// index.html or a real frontend build, depending on whether `task build`'s
// copy step has run before this test — both are valid HTML documents.
func TestRoot_ServesEmbeddedFrontend(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want it to contain %q", ct, "text/html")
	}
	if rec.Body.Len() == 0 {
		t.Fatal("body is empty, want the embedded index.html content")
	}
}

func TestRoot_UnknownPath_NotFound(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// TestHealthz_OverRealListener exercises the handler behind an actual
// bound TCP port (rather than an in-memory recorder), matching the
// acceptance criterion that the server "responds to a basic health-check
// request" once actually listening.
func TestHealthz_OverRealListener(t *testing.T) {
	ts := httptest.NewServer(server.NewHandler(testConfig))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "ok" {
		t.Fatalf("body = %q, want %q", string(body), "ok")
	}
}

// TestWS_ReportsDetectedViewMode is the end-to-end proof that a client
// connecting to /ws over a real socket (not an in-memory recorder, since
// WebSocket upgrades need an actual hijackable connection) can read the View
// Mode the backend detected at startup (issue #9). It asserts the exact mode
// the handler was configured with, so a client could switch rendering
// accordingly.
func TestWS_ReportsDetectedViewMode(t *testing.T) {
	wantMode := kube.ViewModeNode
	ts := httptest.NewServer(server.NewHandler(server.Config{ViewMode: wantMode}))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	defer resp.Body.Close()
	defer conn.Close()

	msgType, body, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	if msgType != websocket.TextMessage {
		t.Fatalf("message type = %d, want %d (TextMessage)", msgType, websocket.TextMessage)
	}

	var msg struct {
		Type     string        `json:"type"`
		ViewMode kube.ViewMode `json:"viewMode"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatalf("unmarshal %q: %v", body, err)
	}
	if msg.Type != "viewMode" {
		t.Errorf("message type field = %q, want %q", msg.Type, "viewMode")
	}
	if msg.ViewMode != wantMode {
		t.Errorf("view mode = %q, want %q", msg.ViewMode, wantMode)
	}
}

// TestWS_RejectsNonUpgradeRequest exercises /ws with a plain HTTP GET (no
// WebSocket upgrade headers), which the upgrader should reject rather than
// serve as a normal response.
func TestWS_RejectsNonUpgradeRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("status = %d, want a non-200 rejection for a non-upgrade request", rec.Code)
	}
}
