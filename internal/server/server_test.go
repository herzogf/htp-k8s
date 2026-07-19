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
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

// testConfig is a server.Config serving a fixed Namespace-mode snapshot, used
// by tests that don't care about the scene's contents.
var testConfig = server.Config{
	Snapshot: server.StaticSnapshot(scene.SceneState{ViewMode: scene.ViewModeNamespace}),
}

// trustedRequest returns an httptest request for path with Host set to an
// IP-literal value (server.AllowedHosts.Permits always trusts these — issue
// #163 / ADR-0013), standing in for a legitimate same-origin client.
// httptest.NewRequest defaults Host to "example.com" for a bare path, which
// the Host allowlist correctly does NOT trust; tests that aren't specifically
// exercising the allowlist itself (hostallowlist_test.go) use this instead,
// so they keep exercising their own handler logic rather than tripping over
// an unrelated 403.
func trustedRequest(method, path string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.Host = "127.0.0.1"
	return req
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

// TestWS_SnapshotThenDeltas proves the ADR-0007 wire shape end to end: with a
// Subscribe configured, the first /ws frame is the full SceneState snapshot
// (well-formed, valid viewMode, no `type` tag — what the e2e smoke test and the
// current frontend rely on), and every frame after it is a Scene Delta carrying
// a `type` discriminator. It also confirms the handler runs the unsubscribe on
// disconnect.
func TestWS_SnapshotThenDeltas(t *testing.T) {
	deltas := make(chan scene.SceneDelta, 2)
	deltas <- scene.SceneDelta{Type: scene.DeltaTowerAdded, Tower: &scene.Tower{Name: "node-x", Panels: []scene.Panel{}}}
	deltas <- scene.SceneDelta{
		Type:      scene.DeltaPanelAdded,
		TowerName: "node-x",
		Panel:     &scene.Panel{Namespace: "ns", Pod: "p1", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}

	var unsubscribed atomic.Bool
	cfg := server.Config{
		Subscribe: func(context.Context) (scene.SceneState, <-chan scene.SceneDelta, func()) {
			return scene.SceneState{ViewMode: scene.ViewModeNode, Towers: []scene.Tower{}},
				deltas,
				func() { unsubscribed.Store(true) }
		},
	}
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	defer resp.Body.Close()

	// Frame 1: the snapshot. It must parse as a SceneState with a valid
	// viewMode and must NOT carry a delta `type` tag.
	_, body, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	var snap scene.SceneState
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("unmarshal snapshot %q: %v", body, err)
	}
	if snap.ViewMode != scene.ViewModeNode {
		t.Errorf("snapshot viewMode = %q, want %q", snap.ViewMode, scene.ViewModeNode)
	}
	var tagged struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &tagged); err != nil {
		t.Fatalf("re-unmarshal snapshot: %v", err)
	}
	if tagged.Type != "" {
		t.Errorf("snapshot carries a delta type tag %q, want none", tagged.Type)
	}

	// Frames 2..: the deltas, each with a `type` discriminator.
	want := []scene.SceneDeltaType{scene.DeltaTowerAdded, scene.DeltaPanelAdded}
	for i, wantType := range want {
		_, body, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read delta %d: %v", i, err)
		}
		var d scene.SceneDelta
		if err := json.Unmarshal(body, &d); err != nil {
			t.Fatalf("unmarshal delta %d %q: %v", i, body, err)
		}
		if d.Type != wantType {
			t.Errorf("delta %d type = %q, want %q", i, d.Type, wantType)
		}
	}

	// Closing the client connection must trigger the handler's unsubscribe.
	conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for !unsubscribed.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !unsubscribed.Load() {
		t.Error("unsubscribe was not called after client disconnect")
	}
}

// TestWS_ClosedDeltaChannelEndsConnection proves a dropped subscriber (its delta
// channel closed by the watcher) ends the /ws connection, so the client can
// reconnect for a fresh snapshot.
func TestWS_ClosedDeltaChannelEndsConnection(t *testing.T) {
	deltas := make(chan scene.SceneDelta)
	cfg := server.Config{
		Subscribe: func(context.Context) (scene.SceneState, <-chan scene.SceneDelta, func()) {
			return scene.SceneState{ViewMode: scene.ViewModeNamespace}, deltas, func() {}
		},
	}
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer resp.Body.Close()
	defer conn.Close()

	if _, _, err := conn.ReadMessage(); err != nil { // consume snapshot
		t.Fatalf("read snapshot: %v", err)
	}

	// Dropping the subscriber closes the channel; the server should then close
	// the connection, which the client observes as a read error.
	close(deltas)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Error("expected connection to close after delta channel closed, got a frame")
	}
}

// TestWS_RejectsNonUpgradeRequest exercises /ws with a plain HTTP GET (no
// WebSocket upgrade headers), which the upgrader should reject rather than
// serve as a normal response. Uses trustedRequest so this specifically
// exercises the upgrader's own rejection, not an unrelated Host-allowlist 403
// (hostallowlist_test.go covers that separately).
func TestWS_RejectsNonUpgradeRequest(t *testing.T) {
	req := trustedRequest(http.MethodGet, "/ws")
	rec := httptest.NewRecorder()

	server.NewHandler(testConfig).ServeHTTP(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("status = %d, want a non-200 rejection for a non-upgrade request", rec.Code)
	}
}
