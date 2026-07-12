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

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

const defaultAddr = ":8080"

// probeTimeout bounds the startup permission probe so a slow or unreachable
// API server can't hang server startup.
const probeTimeout = 10 * time.Second

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

	mode, err := resolveViewMode()
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:    addr,
		Handler: server.NewHandler(server.Config{ViewMode: mode}),
	}

	log.Printf("htp-k8s backend listening on %s", addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}

// resolveViewMode connects to the cluster via the current kubeconfig context
// and determines the startup View Mode.
//
// It returns an error (so the process exits non-zero) only when the API server
// cannot be reached at all — see kube.EnsureReachable for why an unreachable
// cluster is a hard failure while a reachable-but-forbidden one is not. A
// reachable cluster where the user merely cannot list Nodes degrades to
// Namespace-mode and keeps serving, per ADR-0002.
func resolveViewMode() (scene.ViewMode, error) {
	clientset, err := kube.NewClientset()
	if err != nil {
		return "", fmt.Errorf("connect to kubernetes cluster: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	if err := kube.EnsureReachable(ctx, clientset); err != nil {
		return "", err
	}

	mode, err := kube.DetectViewMode(ctx, clientset)
	if err != nil {
		// Reachable but the probe itself errored (e.g. a 403 on the SSAR):
		// ADR-0002 degradation — log why and carry on in Namespace-mode.
		log.Printf("permission probe: %v", err)
	}
	log.Printf("detected view mode: %s", mode)
	return mode, nil
}
