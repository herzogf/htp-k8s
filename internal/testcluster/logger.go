package testcluster

import (
	"sync"
	"testing"

	kindlog "sigs.k8s.io/kind/pkg/log"
)

// tLogger adapts a testing.TB to kind's log.Logger interface, so kind's
// progress/diagnostic output (image pulls, node boot messages, docker
// errors) shows up in `go test -v` output attributed to the right test.
//
// It goes silent after close is called. kind's Docker provider streams some
// output (e.g. node boot logs) from background goroutines; if one of those
// writes to a testing.TB after the test has already finished, it panics the
// whole test binary ("Log in goroutine after Test has completed"). Callers
// must call close once the cluster is fully torn down and no further kind
// calls will happen.
type tLogger struct {
	mu     sync.Mutex
	t      testing.TB
	closed bool
}

func newTLogger(t testing.TB) *tLogger {
	return &tLogger{t: t}
}

func (l *tLogger) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
}

func (l *tLogger) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.t.Helper()
	l.t.Logf(format, args...)
}

func (l *tLogger) Warn(message string) { l.logf("kind: WARN: %s", message) }

func (l *tLogger) Warnf(format string, args ...interface{}) { l.logf("kind: WARN: "+format, args...) }

func (l *tLogger) Error(message string) { l.logf("kind: ERROR: %s", message) }

func (l *tLogger) Errorf(format string, args ...interface{}) { l.logf("kind: ERROR: "+format, args...) }

func (l *tLogger) V(level kindlog.Level) kindlog.InfoLogger {
	return tInfoLogger{l: l, level: level}
}

// tInfoLogger only surfaces kind's top verbosity level (V(0)); higher levels
// are debug/trace noise we don't need in test output.
type tInfoLogger struct {
	l     *tLogger
	level kindlog.Level
}

func (i tInfoLogger) Enabled() bool { return i.level <= 0 }

func (i tInfoLogger) Info(message string) {
	if i.Enabled() {
		i.l.logf("kind: %s", message)
	}
}

func (i tInfoLogger) Infof(format string, args ...interface{}) {
	if i.Enabled() {
		i.l.logf("kind: "+format, args...)
	}
}
