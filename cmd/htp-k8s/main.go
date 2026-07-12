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

	httpServer := &http.Server{
		Addr:    addr,
		Handler: server.NewHandler(server.Config{ViewMode: detectViewMode()}),
	}

	log.Printf("htp-k8s backend listening on %s", addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}

// detectViewMode connects to the cluster via the current kubeconfig context
// and runs the startup permission probe to pick the default View Mode. Per
// ADR-0002 it never fails startup: if no cluster is reachable (no kubeconfig,
// API server down) or the probe errors, it logs the reason and falls back to
// Namespace-mode, keeping the server serving the frontend and /ws regardless.
func detectViewMode() kube.ViewMode {
	clientset, err := kube.NewClientset()
	if err != nil {
		log.Printf("no cluster client (%v); defaulting to %s view mode", err, kube.ViewModeNamespace)
		return kube.ViewModeNamespace
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	mode, err := kube.DetectViewMode(ctx, clientset)
	if err != nil {
		log.Printf("permission probe: %v", err)
	}
	log.Printf("detected view mode: %s", mode)
	return mode
}
