package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

func TestTowerDetail_ReturnsJSON(t *testing.T) {
	cfg := server.Config{
		TowerDetail: func(_ context.Context, name string) (scene.TowerDetail, error) {
			return scene.TowerDetail{
				Name: name,
				Kind: scene.TowerKindNode,
				Node: &scene.NodeSummary{Ready: true, Status: "Ready", CPU: "8"},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/towers/node-a", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got scene.TowerDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (body %q)", err, rec.Body.String())
	}
	if got.Name != "node-a" || got.Kind != scene.TowerKindNode || got.Node == nil || !got.Node.Ready {
		t.Fatalf("got %+v", got)
	}
}

// TestTowerDetail_DegradedStillOK asserts the ADR-0002 posture: a provider that
// returns a partial detail plus an error still yields 200 with the usable detail.
func TestTowerDetail_DegradedStillOK(t *testing.T) {
	cfg := server.Config{
		TowerDetail: func(_ context.Context, name string) (scene.TowerDetail, error) {
			return scene.TowerDetail{Name: name, Kind: scene.TowerKindNode}, errors.New("forbidden")
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/towers/node-a", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (graceful degradation)", rec.Code)
	}
	var got scene.TowerDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Name != "node-a" || got.Node != nil {
		t.Fatalf("got %+v, want name-only degraded detail", got)
	}
}

func TestTowerDetail_NilProvider_Unavailable(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/towers/node-a", nil)
	server.NewHandler(server.Config{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestPodDetail_ReturnsJSON(t *testing.T) {
	cfg := server.Config{
		PodDetail: func(_ context.Context, ns, name string) (scene.PodDetail, error) {
			return scene.PodDetail{
				Namespace:  ns,
				Pod:        name,
				Phase:      scene.PodPhaseRunning,
				Color:      scene.ColorRunning,
				Containers: []scene.ContainerDetail{{Name: "app", State: "Running"}},
				Events:     []scene.PodEvent{},
			}, nil
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/pods/default/web", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got scene.PodDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Namespace != "default" || got.Pod != "web" || len(got.Containers) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestPodDetail_ProviderError_NotFound(t *testing.T) {
	cfg := server.Config{
		PodDetail: func(_ context.Context, ns, name string) (scene.PodDetail, error) {
			return scene.PodDetail{}, errors.New("pod gone")
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/pods/default/ghost", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestDetailEndpoints_ReadOnly is the acceptance guard that no mutating verb is
// reachable on the detail data path (ADR-0003): every non-GET method on every
// detail route must be rejected with 405, never routed to a handler.
func TestDetailEndpoints_ReadOnly(t *testing.T) {
	cfg := server.Config{
		TowerDetail: func(context.Context, string) (scene.TowerDetail, error) { return scene.TowerDetail{}, nil },
		PodDetail:   func(context.Context, string, string) (scene.PodDetail, error) { return scene.PodDetail{}, nil },
		PodLogTail:  func(context.Context, string, string, func(scene.LogTail)) error { return nil },
	}
	handler := server.NewHandler(cfg)

	paths := []string{
		"/api/towers/node-a",
		"/api/pods/default/web",
		"/api/pods/default/web/logtail",
	}
	methods := []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}
	for _, p := range paths {
		for _, m := range methods {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(m, p, nil))
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405 (read-only)", m, p, rec.Code)
			}
		}
	}
}

func TestPodLogTail_SSEFraming(t *testing.T) {
	cfg := server.Config{
		PodLogTail: func(_ context.Context, ns, name string, emit func(scene.LogTail)) error {
			emit(scene.LogTail{Lines: []string{"line-1"}})
			emit(scene.LogTail{Lines: []string{"line-1", "line-2"}})
			return nil
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/pods/default/web/logtail", nil)
	server.NewHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}

	// Two SSE data frames, each a JSON LogTail terminated by a blank line.
	frames := parseSSEData(t, rec.Body.String())
	if len(frames) != 2 {
		t.Fatalf("got %d SSE frames, want 2: %q", len(frames), rec.Body.String())
	}
	var second scene.LogTail
	if err := json.Unmarshal([]byte(frames[1]), &second); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if len(second.Lines) != 2 || second.Lines[1] != "line-2" {
		t.Fatalf("second frame = %+v", second)
	}
}

// TestPodLogTail_CancelOnClientDisconnect verifies that when the client closes
// the SSE stream, the provider's context is cancelled — the "closed the Detail
// Popup" path that must stop the underlying log follow.
func TestPodLogTail_CancelOnClientDisconnect(t *testing.T) {
	providerCtxDone := make(chan struct{})
	cfg := server.Config{
		PodLogTail: func(ctx context.Context, ns, name string, emit func(scene.LogTail)) error {
			emit(scene.LogTail{Lines: []string{"first"}})
			<-ctx.Done() // block until the client goes away
			close(providerCtxDone)
			return ctx.Err()
		},
	}
	ts := httptest.NewServer(server.NewHandler(cfg))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/pods/default/web/logtail", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()

	// Read the first SSE frame so we know the handler is streaming.
	br := bufio.NewReader(resp.Body)
	if _, err := br.ReadString('\n'); err != nil {
		t.Fatalf("read first frame: %v", err)
	}

	// Client disconnects; the server must cancel the provider's context.
	cancel()

	select {
	case <-providerCtxDone:
	case <-time.After(3 * time.Second):
		t.Fatal("provider context not cancelled after client disconnect")
	}
}

// parseSSEData extracts the payloads of `data: ` SSE frames from a stream body.
func parseSSEData(t *testing.T, body string) []string {
	t.Helper()
	var out []string
	for _, block := range strings.Split(strings.TrimSpace(body), "\n\n") {
		block = strings.TrimSpace(block)
		if after, ok := strings.CutPrefix(block, "data: "); ok {
			out = append(out, after)
		}
	}
	return out
}
