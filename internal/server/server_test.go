package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

// testConfig is a server.Config serving a fixed Namespace-mode snapshot, used
// by tests that don't care about the scene's contents.
var testConfig = server.Config{
	Snapshot: server.StaticSnapshot(scene.SceneState{ViewMode: scene.ViewModeNamespace}),
}

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

// TestWS_SendsSceneStateSnapshot is the end-to-end proof that a client
// connecting to /ws over a real socket (not an in-memory recorder, since
// WebSocket upgrades need an actual hijackable connection) receives the
// SceneState snapshot the backend sends on connect (ADR-0007), carrying the
// View Mode detected at startup (issue #9) and the current Towers (issue #12).
// It decodes into scene.SceneState — the exact wire type the generated
// TypeScript mirrors — so the frontend can build the scene from it.
func TestWS_SendsSceneStateSnapshot(t *testing.T) {
	want := scene.SceneState{
		ViewMode: scene.ViewModeNode,
		Towers: []scene.Tower{
			{Name: "node-a", Grid: scene.GridPosition{Col: 0, Row: 0}},
			{Name: "node-b", Grid: scene.GridPosition{Col: 1, Row: 0}},
		},
	}
	ts := httptest.NewServer(server.NewHandler(server.Config{Snapshot: server.StaticSnapshot(want)}))
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

	var got scene.SceneState
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal %q into scene.SceneState: %v", body, err)
	}
	if got.ViewMode != want.ViewMode {
		t.Errorf("view mode = %q, want %q", got.ViewMode, want.ViewMode)
	}
	if !reflect.DeepEqual(got.Towers, want.Towers) {
		t.Errorf("towers = %+v, want %+v", got.Towers, want.Towers)
	}
}

// TestWS_SnapshotBuiltPerConnection proves the snapshot is produced per
// connection (not frozen at handler-build time): two sequential connections
// see two different SceneStates from the same handler.
func TestWS_SnapshotBuiltPerConnection(t *testing.T) {
	var connects int
	cfg := server.Config{
		Snapshot: func(context.Context) scene.SceneState {
			connects++
			return scene.SceneState{
				ViewMode: scene.ViewModeNode,
				Towers:   []scene.Tower{{Name: fmt.Sprintf("node-%d", connects)}},
			}
		},
	}
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	readTowerName := func() string {
		conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", wsURL, err)
		}
		defer resp.Body.Close()
		defer conn.Close()

		_, body, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read message: %v", err)
		}
		var got scene.SceneState
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("unmarshal %q: %v", body, err)
		}
		if len(got.Towers) != 1 {
			t.Fatalf("got %d towers, want 1", len(got.Towers))
		}
		return got.Towers[0].Name
	}

	if first, second := readTowerName(), readTowerName(); first == second {
		t.Errorf("both connections saw tower %q; snapshot was not rebuilt per connection", first)
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
