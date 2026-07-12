// Command htp-k8s is the entrypoint for the htp-k8s backend server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

const defaultAddr = ":8080"

// probeTimeout bounds the startup permission probe so a slow or unreachable
// API server can't hang server startup.
const probeTimeout = 10 * time.Second

// snapshotTimeout bounds the per-connection SceneState build (listing Nodes or
// Namespaces/Projects) so a slow API server can't stall a /ws connect.
const snapshotTimeout = 10 * time.Second

func main() {
	if err := run(os.Args[1:], os.Getenv("HTP_K8S_ADDR")); err != nil {
		log.Fatal(err)
	}
}

// resolveAddr determines the listen address from CLI flags (highest
// precedence), falling back to envAddr, then defaultAddr.
func resolveAddr(args []string, envAddr string) (string, error) {
	addrDefault := defaultAddr
	if envAddr != "" {
		addrDefault = envAddr
	}

	fs := flag.NewFlagSet("htp-k8s", flag.ContinueOnError)
	addr := fs.String("addr", addrDefault, "address (host:port) the server listens on; overrides HTP_K8S_ADDR")
	if err := fs.Parse(args); err != nil {
		return "", err
	}
	return *addr, nil
}

func run(args []string, envAddr string) error {
	addr, err := resolveAddr(args, envAddr)
	if err != nil {
		return err
	}

	client, dyn, err := kube.NewClients()
	if err != nil {
		return fmt.Errorf("connect to kubernetes cluster: %w", err)
	}

	mode, err := resolveViewMode(client)
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:    addr,
		Handler: server.NewHandler(server.Config{Snapshot: snapshotProvider(client, dyn, mode)}),
	}

	log.Printf("htp-k8s backend listening on %s", addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}

// resolveViewMode verifies the cluster is reachable and determines the startup
// View Mode for the given client.
//
// It returns an error (so the process exits non-zero) only when the API server
// cannot be reached at all — see kube.EnsureReachable for why an unreachable
// cluster is a hard failure while a reachable-but-forbidden one is not. A
// reachable cluster where the user merely cannot list Nodes degrades to
// Namespace-mode and keeps serving, per ADR-0002.
func resolveViewMode(client kubernetes.Interface) (scene.ViewMode, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	if err := kube.EnsureReachable(ctx, client); err != nil {
		return "", err
	}

	mode, err := kube.DetectViewMode(ctx, client)
	if err != nil {
		// Reachable but the probe itself errored (e.g. a 403 on the SSAR):
		// ADR-0002 degradation — log why and carry on in Namespace-mode.
		log.Printf("permission probe: %v", err)
	}
	log.Printf("detected view mode: %s", mode)
	return mode, nil
}

// snapshotProvider returns a server.Config.Snapshot function that builds a
// fresh SceneState for each /ws connection: the detected View Mode plus the
// current Towers and Panels listed from the cluster (see kube.BuildTowers and
// kube.BuildPanels). Building per connection keeps the snapshot current without
// a watch cache — deltas that push live changes are a later ticket (ADR-0007).
//
// Neither a Tower- nor a Panel-listing error fails the connection (ADR-0002):
// each is logged and the client still receives a valid SceneState carrying the
// View Mode, just with whatever Towers/Panels were obtained (possibly none).
// This keeps the /ws contract — a well-formed frame with a valid viewMode —
// intact regardless of RBAC.
func snapshotProvider(client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode) func(context.Context) scene.SceneState {
	return func(ctx context.Context) scene.SceneState {
		ctx, cancel := context.WithTimeout(ctx, snapshotTimeout)
		defer cancel()

		towers, err := kube.BuildTowers(ctx, client, dyn, mode)
		if err != nil {
			log.Printf("build towers: %v", err)
		}
		if towers == nil {
			// Keep the wire's Towers a JSON array ([]), never null, even
			// when the listing failed outright (see scene.SceneState.Towers).
			towers = []scene.Tower{}
		}

		panels, err := kube.BuildPanels(ctx, client, mode)
		if err != nil {
			log.Printf("build panels: %v", err)
		}
		if panels == nil {
			// Keep the wire's Panels a JSON array ([]), never null (see
			// scene.SceneState.Panels).
			panels = []scene.Panel{}
		}

		return scene.SceneState{ViewMode: mode, Towers: towers, Panels: panels}
	}
}
