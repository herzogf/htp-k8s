package kube

import (
	"context"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// collectTail runs streamTail over r with the given limit and returns every
// emitted window in order. It is the harness for the pure bounding-logic tests.
func collectTail(t *testing.T, r io.Reader, limit int) [][]string {
	t.Helper()
	var got [][]string
	err := streamTail(context.Background(), r, limit, func(tail scene.LogTail) {
		// Copy: streamTail is free to reuse its backing array between emits.
		window := append([]string(nil), tail.Lines...)
		got = append(got, window)
	})
	if err != nil {
		t.Fatalf("streamTail: %v", err)
	}
	return got
}

func TestStreamTail_EmitsWindowPerLine(t *testing.T) {
	got := collectTail(t, strings.NewReader("a\nb\n"), 3)

	want := [][]string{
		{"a"},
		{"a", "b"},
	}
	if len(got) != len(want) {
		t.Fatalf("emitted %d windows, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if strings.Join(got[i], ",") != strings.Join(want[i], ",") {
			t.Errorf("window %d = %v, want %v", i, got[i], want[i])
		}
	}
}

// TestStreamTail_RingBounded is the core acceptance: the window is never taller
// than the limit no matter how many lines stream, and it holds the most-recent
// `limit` lines, oldest first.
func TestStreamTail_RingBounded(t *testing.T) {
	const limit = 3
	got := collectTail(t, strings.NewReader("l1\nl2\nl3\nl4\nl5\n"), limit)

	if len(got) != 5 {
		t.Fatalf("emitted %d windows, want 5", len(got))
	}
	for i, w := range got {
		if len(w) > limit {
			t.Errorf("window %d has %d lines (%v), exceeds limit %d", i, len(w), w, limit)
		}
	}
	final := got[len(got)-1]
	wantFinal := []string{"l3", "l4", "l5"}
	if strings.Join(final, ",") != strings.Join(wantFinal, ",") {
		t.Errorf("final window = %v, want %v (most-recent %d, oldest first)", final, wantFinal, limit)
	}
}

func TestStreamTail_NoTrailingNewline(t *testing.T) {
	got := collectTail(t, strings.NewReader("only-line"), 3)
	if len(got) != 1 || len(got[0]) != 1 || got[0][0] != "only-line" {
		t.Fatalf("got %v, want a single window [only-line]", got)
	}
}

func TestStreamTail_Empty(t *testing.T) {
	got := collectTail(t, strings.NewReader(""), 3)
	if len(got) != 0 {
		t.Fatalf("got %d windows, want 0 for empty stream", len(got))
	}
}

// TestStreamTail_CancelStopsAtNextLine verifies a cancelled context ends the
// stream promptly: once the reader is closed (as PodLogTail does on ctx.Done),
// streamTail returns without emitting further windows.
func TestStreamTail_CancelStopsAtNextLine(t *testing.T) {
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())

	var mu sync.Mutex
	var emits int
	done := make(chan error, 1)
	go func() {
		done <- streamTail(ctx, pr, 3, func(scene.LogTail) {
			mu.Lock()
			emits++
			mu.Unlock()
		})
	}()

	if _, err := io.WriteString(pw, "first\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Give the first line time to be scanned and emitted.
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return emits == 1 })

	// Cancel and close the reader the way PodLogTail does, then no more windows.
	cancel()
	_ = pr.CloseWithError(context.Canceled)

	select {
	case err := <-done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("streamTail returned %v, want nil or context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("streamTail did not return after cancel + reader close")
	}

	mu.Lock()
	defer mu.Unlock()
	if emits != 1 {
		t.Errorf("emitted %d windows, want exactly 1 before cancel", emits)
	}
}

// TestPodLogTail_FakeClientset exercises the PodLogTail wiring against the fake
// clientset: it requests a following tail with a bounded TailLines and streams
// whatever the API returns through the ring, returning cleanly at end-of-stream.
// The fake clientset yields a canned log body (a real live-follow with genuine
// log output is covered by the integration test), so this asserts the wiring and
// bounding, not real following.
func TestPodLogTail_FakeClientset(t *testing.T) {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	client := fake.NewSimpleClientset(p)

	baseGoroutines := runtime.NumGoroutine()

	var mu sync.Mutex
	var last scene.LogTail
	var emits int
	err := PodLogTail(context.Background(), client, "default", "web", func(tail scene.LogTail) {
		mu.Lock()
		defer mu.Unlock()
		emits++
		last = tail
	})
	if err != nil {
		t.Fatalf("PodLogTail: %v", err)
	}

	mu.Lock()
	if emits == 0 {
		t.Fatal("PodLogTail emitted no windows from the canned stream")
	}
	if len(last.Lines) > scene.LogTailMaxLines {
		t.Errorf("final window has %d lines, exceeds cap %d", len(last.Lines), scene.LogTailMaxLines)
	}
	mu.Unlock()

	// The ctx-watcher goroutine must exit when the stream ends on its own, even
	// though this ctx (Background) is never cancelled — otherwise it would leak.
	assertNoLingeringGoroutine(t, baseGoroutines)
}

// assertNoLingeringGoroutine polls until the goroutine count settles back to at
// most base, failing if PodLogTail left a goroutine running past its return.
func assertNoLingeringGoroutine(t *testing.T, base int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= base {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("goroutine count %d did not settle back to %d — PodLogTail leaked a goroutine",
		runtime.NumGoroutine(), base)
}

// TestPodLogTail_CancelReturns asserts PodLogTail returns promptly when its
// context is cancelled, without leaking — the "client closed the Detail Popup"
// path.
func TestPodLogTail_CancelReturns(t *testing.T) {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	client := fake.NewSimpleClientset(p)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	done := make(chan error, 1)
	go func() {
		done <- PodLogTail(ctx, client, "default", "web", func(scene.LogTail) {})
	}()

	select {
	case <-done:
		// Returned (with or without an error) — the point is it did not hang.
	case <-time.After(2 * time.Second):
		t.Fatal("PodLogTail did not return after context cancellation")
	}
}

// waitFor polls cond until true or fails the test after a short deadline.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}
