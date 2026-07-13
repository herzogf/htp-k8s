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

	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

const defaultAddr = ":8080"

// Build metadata. These defaults apply to plain `go build` / `go run` dev
// builds; release builds inject the real values via `-ldflags -X` — both
// GoReleaser (see .goreleaser.yaml) and ko (see .ko.yaml) set them, so a
// released binary and the released container image both self-report their
// version via `htp-k8s version` / `htp-k8s --version`.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// probeTimeout bounds the startup permission probe so a slow or unreachable
// API server can't hang server startup.
const probeTimeout = 10 * time.Second

func main() {
	args := os.Args[1:]
	// Handle version reporting before anything else — it must work without a
	// reachable cluster (unlike run, which connects on startup).
	if versionRequested(args) {
		fmt.Println(versionString())
		return
	}
	if err := run(args, os.Getenv); err != nil {
		log.Fatal(err)
	}
}

// versionRequested reports whether args ask for version output, via either the
// `version` subcommand (first arg) or a `-version`/`--version` flag. Checked
// before flag parsing because parseFlags's FlagSet only knows its own flags and
// would otherwise reject `-version` as an unknown flag.
func versionRequested(args []string) bool {
	if len(args) > 0 && args[0] == "version" {
		return true
	}
	for _, a := range args {
		if a == "-version" || a == "--version" {
			return true
		}
	}
	return false
}

// versionString renders the build metadata injected at release time (or the
// dev-build defaults) as a single line for `htp-k8s version`.
func versionString() string {
	return fmt.Sprintf("htp-k8s %s (commit %s, built %s)", version, commit, date)
}

// options is the runtime configuration parsed from CLI flags and environment.
type options struct {
	// addr is the host:port the server listens on.
	addr string
	// filter is the startup Namespace Filter preset applied to every scene.
	filter kube.NamespaceFilter
}

// parseFlags parses the CLI flags into runtime options, applying environment
// fallbacks for any value not given on the command line (flag > env > default).
// It also builds and validates the Namespace Filter preset here, so a malformed
// name pattern or label selector — or asking for two filter modes at once —
// fails at startup rather than silently misbehaving. env is injected (rather
// than calling os.Getenv directly) so tests can drive it hermetically.
func parseFlags(args []string, env func(string) string) (options, error) {
	addrDefault := defaultAddr
	if v := env("HTP_K8S_ADDR"); v != "" {
		addrDefault = v
	}

	fs := flag.NewFlagSet("htp-k8s", flag.ContinueOnError)
	addr := fs.String("addr", addrDefault,
		"address (host:port) the server listens on; overrides HTP_K8S_ADDR")
	namePattern := fs.String("namespace-filter", env("HTP_K8S_NAMESPACE_FILTER"),
		"preset Namespace/Project name filter with shell wildcards (e.g. 'openshift-*'); the default filter mode. Overrides HTP_K8S_NAMESPACE_FILTER")
	labelSelector := fs.String("namespace-label-filter", env("HTP_K8S_NAMESPACE_LABEL_FILTER"),
		"preset advanced Namespace/Project label selector (e.g. 'team=platform'); mutually exclusive with -namespace-filter. Overrides HTP_K8S_NAMESPACE_LABEL_FILTER")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}

	filter, err := buildFilter(*namePattern, *labelSelector)
	if err != nil {
		return options{}, err
	}
	return options{addr: *addr, filter: filter}, nil
}

// buildFilter turns the two mutually-exclusive filter flags into a single
// NamespaceFilter. Name-pattern matching is the default mode; the label
// selector is the advanced alternative. Setting both is rejected — there is one
// filter in one mode — and an empty pair yields the no-filter zero value, so
// nothing is hidden by default.
func buildFilter(namePattern, labelSelector string) (kube.NamespaceFilter, error) {
	switch {
	case namePattern != "" && labelSelector != "":
		return kube.NamespaceFilter{}, errors.New(
			"set only one of -namespace-filter (name mode) or -namespace-label-filter (label mode), not both")
	case labelSelector != "":
		return kube.LabelFilter(labelSelector)
	default:
		// Empty namePattern yields the no-filter zero value (admits everything).
		return kube.NameFilter(namePattern)
	}
}

func run(args []string, env func(string) string) error {
	opts, err := parseFlags(args, env)
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

	// One shared watcher backs every /ws connection: it holds a live SceneState
	// (LIST + WATCH) and fans Scene Deltas out to subscribers, so a client gets
	// a fresh snapshot on connect (or reconnect) then only deltas (ADR-0007). It
	// runs for the process's lifetime; ctx cancellation (below) stops it.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watcher := kube.NewSceneWatcher(client, dyn, mode, opts.filter)
	watcher.Start(ctx)

	httpServer := &http.Server{
		Addr: opts.addr,
		Handler: server.NewHandler(server.Config{
			Subscribe: func(context.Context) (scene.SceneState, <-chan scene.SceneDelta, func()) {
				return watcher.SnapshotAndSubscribe()
			},
		}),
	}

	log.Printf("htp-k8s backend listening on %s", opts.addr)
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
