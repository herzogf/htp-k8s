package kube

import (
	"bufio"
	"context"
	"fmt"
	"io"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// maxLogLineBytes caps the length of a single log line the tail will buffer. A
// pathological producer that never emits a newline must not make the tail buffer
// unbounded memory (the whole point of a *bounded* tail); a line longer than
// this ends the scan rather than growing without limit. 64 KiB is far larger
// than any human-readable log line while keeping the worst case tiny.
const maxLogLineBytes = 64 * 1024

// PodLogTail opens a bounded, live-following log tail for one pod and drives emit
// with the current tail window each time a new line arrives, blocking until the
// stream ends or ctx is cancelled. It is the Detail Popup's log tail (CONTEXT.md):
// a small (~scene.LogTailMaxLines row) live tail, never a full log viewer, and
// strictly read-only (ADR-0003) — it uses only the pod log read API, never exec.
//
// It is bounded on every axis: TailLines caps the initial history the API server
// sends to scene.LogTailMaxLines, streamTail keeps only that many lines in a ring
// regardless of how much the pod logs thereafter, and maxLogLineBytes caps a
// single line. It is cancellable: cancelling ctx (e.g. the client closing the
// Detail Popup / disconnecting) both propagates to the streaming request and
// closes the reader, so a Read blocked waiting for the next line unblocks
// promptly rather than leaking a goroutine or an open request against the API
// server.
//
// Following logs requires a running container that actually produces log output;
// the fake clientset returns a canned stream and a KWOK-simulated pod produces
// none, so the live-follow behaviour is exercised against a real kind-scheduled
// pod (see the integration test) while the pure bounding logic is unit-tested via
// streamTail.
func PodLogTail(ctx context.Context, client kubernetes.Interface, namespace, name string, emit func(scene.LogTail)) error {
	tail := int64(scene.LogTailMaxLines)
	req := client.CoreV1().Pods(namespace).GetLogs(name, &corev1.PodLogOptions{
		Follow:    true,
		TailLines: &tail,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		return fmt.Errorf("open log stream for pod %s/%s: %w", namespace, name, err)
	}
	defer func() { _ = stream.Close() }()

	// A blocking Read on the follow stream won't notice ctx cancellation on its
	// own, so close the stream when ctx is done to unblock streamTail promptly.
	// Closing an already-closed stream (the normal-return path) is harmless.
	go func() {
		<-ctx.Done()
		_ = stream.Close()
	}()

	return streamTail(ctx, stream, scene.LogTailMaxLines, emit)
}

// streamTail is the pure bounding core of the log tail: it reads r line by line,
// maintaining a ring of at most limit most-recent lines, and calls emit with the
// current window (oldest first) each time a new line arrives. It returns when r
// reaches EOF or errors (including being closed on ctx cancellation) or when ctx
// is already cancelled, whichever comes first. It never buffers more than limit
// lines, so memory stays bounded no matter how long the pod logs.
//
// Separated from PodLogTail — which owns the Kubernetes specifics — so the
// bounding and windowing logic is unit-testable against any io.Reader without a
// cluster.
func streamTail(ctx context.Context, r io.Reader, limit int, emit func(scene.LogTail)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), maxLogLineBytes)

	ring := make([]string, 0, limit)
	for sc.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		ring = append(ring, sc.Text())
		if len(ring) > limit {
			// Slide the window down to the most-recent limit lines and truncate,
			// so the backing array never grows past limit+1 (bounded memory).
			copy(ring, ring[len(ring)-limit:])
			ring = ring[:limit]
		}

		window := make([]string, len(ring))
		copy(window, ring)
		emit(scene.LogTail{Lines: window})
	}

	// A closed reader surfaces as a scan error; treat a cancelled context as a
	// clean stop rather than a failure so the caller doesn't log a spurious error
	// on the normal "client went away" path.
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}
