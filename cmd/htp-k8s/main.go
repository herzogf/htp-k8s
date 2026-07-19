// Command htp-k8s is the entrypoint for the htp-k8s backend server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/server"
)

// defaultAddr is loopback-only (issue #127): htp-k8s has no authentication or
// authorization layer anywhere in internal/server (ADR-0003 keeps it a
// read-only viewer, not a reason to add one), so a non-loopback default would
// hand anyone who can reach the port a read-only view of the operator's
// cluster under the operator's own credentials. htp-k8s's default use case is
// local — the browser runs on the same machine as the server, whether or not
// the *cluster* itself is local or remote (this holds even for the
// conference-showcase Demo Mode) — so binding wider by default buys nothing
// for that case and costs real exposure for everyone else. -addr/HTP_K8S_ADDR
// is the explicit opt-in to expose (e.g. `-addr :8080`).
//
// BREAKING CHANGE, but narrower than it first looks: this does NOT newly
// break the primary "load the page in a browser on another machine" case —
// that was already broken on the OLD all-interfaces default too, because the
// released frontend's WebSocket target used to be baked to
// ws://localhost:8080/ws regardless of where the page was loaded from, so a
// remote browser already got a blank/stalled page there, not a working live
// scene. Issue #146 removed that: the frontend now derives its /ws and /api
// target from the page's own origin, so widening -addr/HTP_K8S_ADDR alone is
// now sufficient for a remote browser too — no frontend rebuild needed. What
// silently breaks on upgrade: anyone reaching /api endpoints directly from
// another host (curl, custom tooling, monitoring) needs -addr/HTP_K8S_ADDR
// widened same as before. See run()'s startup log line, which always states
// the listen address and, when it's loopback, exactly how to widen it — the
// operator finds out from the log, not by discovering the app is
// unreachable from elsewhere.
//
// The image BINARY has this same loopback default — it is not an exception.
// What IS an exception is the documented `docker run` recipe (README.md),
// which passes -e HTP_K8S_ADDR=:8080 explicitly: Docker's `-p` port
// publishing forwards to the *container's* interface address, not its
// loopback, so a container left on the loopback default would never see
// traffic `-p` forwards to it, breaking `docker run -p 127.0.0.1:8080:8080
// ...` even though that command's host-side loopback binding is what
// actually restricts access. Baking a wider default into the image binary
// itself (rather than the recipe) IS mechanically possible via an
// image-only `-X main.defaultAddr=...` ldflag in .ko.yaml (which already
// has its own ldflags block, distinct from GoReleaser's) — deliberately not
// done, because it would make the --network host fallback recipe
// (README.md) fail OPEN: forgetting -e HTP_K8S_ADDR=127.0.0.1:8080 there
// would silently expose every host interface instead of just losing
// connectivity. Every other way to forget a flag in this design fails
// closed (see main_test.go and README.md); this is the one shape that
// wouldn't, so it stays a recipe-level flag instead. (ko itself has no
// supported way to set a container-*runtime* env var — verified against ko
// v0.19.1 and GoReleaser v2.17.0's `kos:` pipe while investigating this
// issue; both only expose Go *build*-time env, never the OCI image's
// runtime Config.Env — but that's a different question from the ldflag
// option above, which doesn't go through either.)
const defaultAddr = "127.0.0.1:8080"

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

// detailTimeout bounds a single on-demand Detail Popup fetch (a Tower or Pod
// detail lookup) so a slow API server can't leave a request hanging. It does NOT
// apply to the log tail, which is a long-lived follow stream bounded instead by
// the client staying connected.
const detailTimeout = 10 * time.Second

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
	// demoSeed is the seed for Demo Mode's canyon-tour PRNG (ADR-0010),
	// resolved by resolveDemoSeed: the -demo-seed/HTP_K8S_DEMO_SEED value if
	// set, otherwise a random seed chosen at startup. Always logged (see run)
	// since seed + Tower count is the tour's reproduction key.
	demoSeed int64
	// demoAutostart reports whether Demo Mode should start automatically at
	// launch (-demo/HTP_K8S_DEMO). Orthogonal to demoSeed — a seed can be
	// preset without auto-starting the flight.
	demoAutostart bool
	// allowedHosts is the extra Host-header allowlist entries for /ws and
	// /api (-allowed-hosts/HTP_K8S_ALLOWED_HOSTS, issue #163, ADR-0013),
	// beyond what server.NewAllowedHosts always trusts on its own (loopback,
	// and addr when it names a concrete IP). Needed for a reverse proxy or
	// any DNS-name deployment; a wildcard bind (":8080") can't derive its own
	// reachable name, so that case genuinely requires this.
	allowedHosts []string
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
	demoDefault := false
	if v := env("HTP_K8S_DEMO"); v != "" {
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			return options{}, fmt.Errorf("invalid HTP_K8S_DEMO value %q: %w", v, err)
		}
		demoDefault = parsed
	}

	fs := flag.NewFlagSet("htp-k8s", flag.ContinueOnError)
	addr := fs.String("addr", addrDefault,
		"address (host:port) the server listens on; overrides HTP_K8S_ADDR")
	namePattern := fs.String("namespace-filter", env("HTP_K8S_NAMESPACE_FILTER"),
		"preset Namespace/Project name filter with shell wildcards (e.g. 'openshift-*'); the default filter mode. Overrides HTP_K8S_NAMESPACE_FILTER")
	labelSelector := fs.String("namespace-label-filter", env("HTP_K8S_NAMESPACE_LABEL_FILTER"),
		"preset advanced Namespace/Project label selector (e.g. 'team=platform'); mutually exclusive with -namespace-filter. Overrides HTP_K8S_NAMESPACE_LABEL_FILTER")
	demoSeedRaw := fs.String("demo-seed", env("HTP_K8S_DEMO_SEED"),
		"seed for Demo Mode's canyon-tour PRNG (ADR-0010); a random seed is chosen at startup if unset. Overrides HTP_K8S_DEMO_SEED")
	demo := fs.Bool("demo", demoDefault,
		"auto-start Demo Mode at launch; independent of -demo-seed. Overrides HTP_K8S_DEMO")
	allowedHostsRaw := fs.String("allowed-hosts", env("HTP_K8S_ALLOWED_HOSTS"),
		"comma-separated extra hostnames /ws and /api trust in the HTTP Host header (ports ignored), beyond loopback and the host -addr names (issue #163); needed for a reverse proxy or a wildcard -addr bind, which can't derive its own reachable name. Overrides HTP_K8S_ALLOWED_HOSTS")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}

	filter, err := buildFilter(*namePattern, *labelSelector)
	if err != nil {
		return options{}, err
	}
	demoSeed, err := resolveDemoSeed(*demoSeedRaw)
	if err != nil {
		return options{}, err
	}
	return options{
		addr:          *addr,
		filter:        filter,
		demoSeed:      demoSeed,
		demoAutostart: *demo,
		allowedHosts:  splitAllowedHosts(*allowedHostsRaw),
	}, nil
}

// splitAllowedHosts parses the comma-separated -allowed-hosts/
// HTP_K8S_ALLOWED_HOSTS value into individual hostnames, trimming whitespace
// and dropping empty entries (so a trailing comma or extra spaces don't
// produce a spurious blank entry).
func splitAllowedHosts(raw string) []string {
	if raw == "" {
		return nil
	}
	var hosts []string
	for _, h := range strings.Split(raw, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

// resolveDemoSeed parses the -demo-seed/HTP_K8S_DEMO_SEED value into the seed
// Demo Mode's canyon-tour PRNG uses (ADR-0010), resolving a random seed when
// raw is empty (neither flag nor env set). Demo Mode always has a seed either
// way — an operator who never sets one still gets a reproducible tour, since
// the resolved seed is logged (see run) and served at GET /api/config.
func resolveDemoSeed(raw string) (int64, error) {
	if raw == "" {
		return time.Now().UnixNano(), nil
	}
	seed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid demo seed %q: %w", raw, err)
	}
	return seed, nil
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

	// Demo Mode's Canyon tour (ADR-0010) is a deterministic function of
	// (seed, Tower arrangement, entry waypoint): log the seed plus the current
	// Tower count together, on one line, as the reproduction key — a Tower
	// count change later (logged by the watcher as it occurs) is what would
	// legitimately diverge a "same seed" replay.
	log.Printf("demo seed: %d (tower count: %d)", opts.demoSeed, watcher.TowerCount())

	httpServer := &http.Server{
		Addr: opts.addr,
		Handler: server.NewHandler(server.Config{
			DemoSeed:      opts.demoSeed,
			DemoAutostart: opts.demoAutostart,
			// The Host allowlist for /ws and /api (issue #163, ADR-0013):
			// loopback and the addr host (if a concrete IP) are always
			// trusted; opts.allowedHosts adds any -allowed-hosts entries for
			// reverse-proxy/DNS-name deployments or a wildcard bind.
			AllowedHosts: server.NewAllowedHosts(opts.addr, opts.allowedHosts),
			Subscribe: func(context.Context) (scene.SceneState, <-chan scene.SceneDelta, func()) {
				return watcher.SnapshotAndSubscribe()
			},
			// On-demand Detail Popup data (issue #23), served off the /ws stream
			// so per-click detail never bloats the SceneState broadcast. All
			// read-only (ADR-0003). Detail fetches are bounded by detailTimeout;
			// the log tail deliberately is not (it follows until the client
			// disconnects, which cancels the request context).
			TowerDetail: func(ctx context.Context, name string) (scene.TowerDetail, error) {
				ctx, cancel := context.WithTimeout(ctx, detailTimeout)
				defer cancel()
				return kube.BuildTowerDetail(ctx, client, dyn, mode, name)
			},
			PodDetail: func(ctx context.Context, namespace, name string) (scene.PodDetail, error) {
				ctx, cancel := context.WithTimeout(ctx, detailTimeout)
				defer cancel()
				return kube.BuildPodDetail(ctx, client, namespace, name)
			},
			PodLogTail: func(ctx context.Context, namespace, name string, emit func(scene.LogTail)) error {
				return kube.PodLogTail(ctx, client, namespace, name, emit)
			},
		}),
	}

	logListenAddr(opts.addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}

// logListenAddr logs the address htp-k8s is about to listen on, and — since
// there is no authentication layer anywhere in internal/server (issue #127) —
// always makes the exposure explicit rather than a one-line fact easy to miss:
// a loopback bind gets a reminder of exactly how to widen it (matching flag
// AND env var, so either form an operator reaches for works), and a
// non-loopback bind gets a loud warning naming precisely what that means.
// Called before ListenAndServe (which blocks), matching this function's
// previous unconditional log line — an invalid addr still fails at bind time
// with its own clear error, so logging the intent first is fine either way.
func logListenAddr(addr string) {
	log.Printf("htp-k8s backend listening on %s", addr)
	if isLoopbackAddr(addr) {
		log.Printf("bound to loopback only — reachable from this machine, not from other hosts. To expose it, set -addr :8080 or HTP_K8S_ADDR=:8080 — that alone is now enough for a remote browser (see README.md for the security implications)")
		return
	}
	log.Printf("WARNING: bound to %s (not loopback-only) with no authentication — anyone who can reach this port gets read-only access to your cluster under your credentials", addr)
}

// isLoopbackAddr reports whether addr (a listen address in host:port form, as
// taken by http.Server.Addr) binds to loopback only. It affects ONLY which
// startup log line is printed above — never behavior — so a host form this
// can't parse (or a hostname it can't resolve) safely falls back to "not
// loopback": that's the conservative direction for a security-relevant log
// message, and net.Listen gets the final, authoritative say over what the
// process actually binds to regardless of what this reports.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		// Not a valid host:port at all (e.g. missing the port); net.Listen
		// will reject it shortly with its own clear error either way.
		return false
	}
	if host == "" {
		// The ":8080" form — no host means "all interfaces".
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// A hostname other than "localhost" — DNS could resolve it to
		// anything, so don't claim loopback.
		return false
	}
	return ip.IsLoopback()
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
