package kube

import (
	"testing"

	corev1 "k8s.io/api/core/v1"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// restartPod builds a pod with one container status carrying the given restart
// count and phase — the raw shape podBlinkActivity compares.
func restartPod(phase corev1.PodPhase, restarts int32) *corev1.Pod {
	return &corev1.Pod{
		Status: corev1.PodStatus{
			Phase: phase,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:         "app",
				RestartCount: restarts,
				State:        corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}},
		},
	}
}

// crashLooping builds a pod whose (Running) phase is overridden by a container
// waiting in CrashLoopBackOff, so derivePhase reports CrashLoopBackOff.
func crashLooping(restarts int32) *corev1.Pod {
	return &corev1.Pod{
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:         "app",
				RestartCount: restarts,
				State: corev1.ContainerState{
					Waiting: &corev1.ContainerStateWaiting{Reason: crashLoopBackOff},
				},
			}},
		},
	}
}

// TestPodBlinkActivity is the pure activity-detection seam: given an old→new pod
// pair it decides whether the transition is blink-worthy and which kind, with
// restart taking precedence over a phase change and no-op updates yielding
// nothing.
func TestPodBlinkActivity(t *testing.T) {
	tests := []struct {
		name     string
		old, new *corev1.Pod
		want     scene.PanelActivity
		wantOK   bool
	}{
		{
			name: "phase transition Pending to Running",
			old:  restartPod(corev1.PodPending, 0),
			new:  restartPod(corev1.PodRunning, 0),
			want: scene.ActivityPhaseChange, wantOK: true,
		},
		{
			name: "restart count increase, same phase",
			old:  restartPod(corev1.PodRunning, 0),
			new:  restartPod(corev1.PodRunning, 1),
			want: scene.ActivityRestart, wantOK: true,
		},
		{
			name: "restart takes precedence over a concurrent phase change",
			old:  restartPod(corev1.PodPending, 0),
			new:  crashLooping(2),
			want: scene.ActivityRestart, wantOK: true,
		},
		{
			name: "entering CrashLoopBackOff without a restart bump is a phase change",
			old:  restartPod(corev1.PodRunning, 3),
			new:  crashLooping(3),
			want: scene.ActivityPhaseChange, wantOK: true,
		},
		{
			name:   "no-op update yields nothing",
			old:    restartPod(corev1.PodRunning, 1),
			new:    restartPod(corev1.PodRunning, 1),
			wantOK: false,
		},
		{
			name:   "restart-count decrease (container replaced) is not activity",
			old:    restartPod(corev1.PodRunning, 5),
			new:    restartPod(corev1.PodRunning, 0),
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := podBlinkActivity(tt.old, tt.new)
			if ok != tt.wantOK || (ok && got != tt.want) {
				t.Fatalf("podBlinkActivity() = (%q, %v), want (%q, %v)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}
