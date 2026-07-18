# Running htp-k8s locally

This is the **developer / advanced-tester** recipe: build the app from source and
run it against a populated, multi-tower scene so you can explore behaviour the
automated tests deliberately don't judge — Demo Mode's camera choreography, how a
scene *feels*, how phase colours read (ADR-0004 scopes the e2e suite to mechanics,
not "does it feel cinematic"; ADR-0011 keeps aesthetic sign-off human).

If you just want to *use* a released build against a cluster you already have, start
with the quickstart in the [README](../README.md) — this document is the fuller
build-from-source recipe, plus the detail and troubleshooting behind the README's
container commands (see [The container image](#the-container-image) below).

The scene you'll get: **1 real kind node + 6 KWOK-simulated nodes = 7 Towers**, with
**30 seeded pods** spread across a mix of phases (Running, Pending, Succeeded, Failed,
CrashLoopBackOff) so the Panels show the full colour range.

## Prerequisites

You need these on `PATH`:

| Tool | Notes |
| --- | --- |
| `docker` | A running daemon — kind runs the cluster node as a container. |
| `kind` | Creates the local Kubernetes cluster (tested with v0.31). |
| `kubectl` | The seed script applies manifests through it. |
| `go` | 1.26.x — compiles the backend. |
| `node` + `npm` | Node 24.x — builds the embedded frontend. |
| `task` | [Task](https://taskfile.dev) 3.x — runs the build target. |

You do **not** need the `kwok` CLI: the seed script applies the vendored KWOK
manifests (`internal/testcluster/manifests/`) through `kubectl`, and a KWOK
*controller* runs inside the cluster to bring the fake nodes/pods to life.

On the maintainer's setup, `go` and `task` come onto `PATH` via `. ~/.profile` —
run that first if `go version` / `task --version` don't resolve.

## Steps

Run these from the repository root (a normal checkout is fine — you do not need a
separate worktree).

### 1. Create the cluster

```bash
kind create cluster --name htp-demo
```

This also sets your `kubectl` context to `kind-htp-demo`, which is the kubeconfig
the app and the seed script both pick up.

### 2. Seed the populated scene

```bash
./test/e2e/kwok/seed.sh
```

Takes about a minute. It installs the KWOK controller, adds 6 fake Ready nodes and
30 pods, then patches a subset into varied phases. It's a **hard gate**: it verifies
the end state and exits non-zero if the scene isn't fully populated, so a green exit
means the scene is really there. You'll see a summary table of nodes and the pod
phase spread at the end.

Without this step you get only the single real kind node — one lone Tower. The seed
is what makes it a multi-tower scene.

### 3. Build the binary

```bash
. ~/.profile     # if go/task aren't already on PATH
task build
```

`task build` regenerates the frontend's TypeScript wire types from the Go
`SceneState` (tygo codegen), runs `npm ci`, builds the frontend with Vite, copies
`web/dist` into `internal/server/dist`, and compiles `bin/htp-k8s` with the frontend
**embedded via `go:embed`** (ADR-0001). The result is a single self-contained binary
— there is no separate frontend server to run. (Vite prints a "chunk larger than
500 kB" warning; it's benign.)

### 4. Run it

```bash
./bin/htp-k8s
```

The binary serves everything on `http://localhost:8080` against your current
kubeconfig:

- the UI at `/`,
- the one-way scene broadcast at `/ws` (a `SceneState` snapshot, then Scene Deltas),
- the read-only detail/log endpoints under `/api` (ADR-0009).

Open <http://localhost:8080>. On startup the log prints the detected View Mode, the
Demo Mode seed, and the Tower count — expect `tower count: 7` with the seeded scene.

Quick sanity check without a browser:

```bash
curl -s http://localhost:8080/api/config                 # {"demoSeed":...,"demoAutostart":false}
curl -s http://localhost:8080/api/towers/kwok-node-0     # tower detail, podCount 7
```

`podCount 7`, not 5, is correct: each fake node carries 5 of the 30 seeded pods
*plus* the two DaemonSet pods a default kind cluster runs on every node
(`kindnet`, `kube-proxy`). The fake nodes do carry a
`kwok.x-k8s.io/node=fake:NoSchedule` taint to keep ordinary workloads off them,
but both of those DaemonSets ship with a blanket `tolerations: [{operator:
Exists}]`, so the taint doesn't exclude them. The detail endpoint then counts
every pod bound to the Node in any Namespace (`countPodsOnNode` lists
`NamespaceAll`), so they land in `podCount` — and the Namespace filter flags
below don't change it.

`5` is the *seeded*-pod count — 30 pods over 6 fake nodes — which is not what
this endpoint reports.

## Controls

- **Free-fly:** click the canvas to grab pointer-lock, then `WASD` or the arrow
  keys to fly; `Space`/`Shift` to rise and descend; mouse to look around;
  `Esc` releases the pointer.
- **Focus + detail:** with the pointer released, click a Tower or a Panel to
  smoothly focus the camera on it and open its read-only Detail Popup (Panel
  popups include a short live log tail). Close it with its own close button,
  `Esc`, or by clicking empty space.
- **Demo Mode:** the toggle at the top-right starts the automated cinematic
  canyon-tour flight (ADR-0010); manual free-fly is inert while it's running,
  and resumes exactly where the flight left off as soon as you switch it back
  off.
- **Quit:** close the browser tab, then `Ctrl-C` the running binary (or stop the
  container) — see [Teardown](#teardown) below if you also seeded a kind cluster.

## Useful flags for testing

The binary takes a few flags (each also has an `HTP_K8S_*` environment fallback):

| Flag | Env | Purpose |
| --- | --- | --- |
| `-addr` | `HTP_K8S_ADDR` | Listen address; default `127.0.0.1:8080` (**loopback only** — there's no auth layer, so nothing is reachable off this machine unless you opt in; see [ADR-0012](adr/0012-loopback-listen-address-by-default.md)). Pass `-addr :8080` to widen it — but that alone only reaches `/api` directly (curl, custom tooling); a remote *browser* additionally needs the frontend rebuilt with `VITE_WS_URL`, same as changing the port does. See the `/ws` gotcha below. |
| `-demo` | `HTP_K8S_DEMO` | Auto-start Demo Mode at launch — handy for unattended showcase runs. |
| `-demo-seed` | `HTP_K8S_DEMO_SEED` | Fix the canyon-tour PRNG seed so a flight is reproducible (ADR-0010). A random seed is chosen and logged otherwise. |
| `-namespace-filter` | `HTP_K8S_NAMESPACE_FILTER` | Preset a name-pattern Namespace/Project filter (shell wildcards, e.g. `openshift-*`). |
| `-namespace-label-filter` | `HTP_K8S_NAMESPACE_LABEL_FILTER` | Preset a label-selector filter instead (mutually exclusive with the name filter). |

`./bin/htp-k8s version` (or `--version`) prints build metadata and works without a
cluster.

To reproduce a specific Demo Mode flight, launch with the same seed **and** the same
Tower arrangement — the tour is a deterministic function of the seed plus the scene:

```bash
./bin/htp-k8s -demo -demo-seed 42
```

## Gotchas

- **The `/ws` URL is baked in at build time — this also means `-addr`/`HTP_K8S_ADDR`
  alone never makes the live scene reachable from another machine.** The frontend
  defaults to `ws://localhost:8080/ws` (`DEFAULT_WS_URL` in `web/src/config.ts`),
  which a browser resolves relative to *itself*, not to wherever htp-k8s is
  running — so **run on port 8080** (the default) for the same-machine case, and
  for a remote browser, widening `-addr`/`HTP_K8S_ADDR` to `:8080` only gets you a
  loaded page with no data (the WebSocket dials the *viewer's* localhost). Either
  way, rebuild with the real address baked in to fix it:
  `VITE_WS_URL=ws://host:port/ws task build` (the `/api` origin is derived from
  it, or overridden with `VITE_API_URL`). Passing `-addr` alone moves the server
  but not the URL the already-built frontend dials.
- **No cluster, no start.** The binary probes the cluster on startup and **exits
  non-zero if the API server is unreachable** (implemented for issue #9). A cluster
  that's reachable but where you can't list Nodes doesn't fail — it degrades to
  Namespace View Mode and keeps serving (ADR-0002). So a reachable kubeconfig
  (the kind cluster above, or any other) is required.
- **One lone Tower?** You skipped step 2 — without the seed you only see the single
  real kind node.

## The container image

The README's Quickstart has the commands; this section is the detail and troubleshooting behind them. Why loopback by default at all, why the container needs a wider default than the native binary, and the alternatives that were considered and rejected for it, are [ADR-0012](adr/0012-loopback-listen-address-by-default.md) — that reasoning isn't repeated here.

**The kubeconfig mount.** The container looks for a kubeconfig at `/kube/config` by default, so mounting yours there (`-v "$HOME/.kube/config:/kube/config:ro"`) is all that's needed — no `-e KUBECONFIG` boilerplate. Mounting elsewhere? Override it explicitly: add `-e KUBECONFIG=/some/other/path` and mount to match. The container exits immediately if it can't reach a cluster; if you forget the `-v` mount entirely, the error names the missing `/kube/config` path and the flag to fix it.

**`--user "$(id -u):$(id -g)"`.** Every container recipe includes this. It makes the container read the kubeconfig mount as you, rather than as its own built-in non-root user: a standard kind/kubectl-written kubeconfig is mode `0600` (owner-read-only), and without this flag the container can't read a file it doesn't own — it fails with `permission denied`, and the resulting error names this exact flag. `$(id -u)` is bash/zsh syntax (Linux, macOS Terminal); PowerShell and cmd.exe have no `id` command, so on Windows drop the flag and try the plain command first. We haven't verified on this project how Docker Desktop's bind-mount layer handles host file permissions on Windows or macOS — if you still hit `permission denied` there, mounting a copy of your kubeconfig with broader read permissions is a fallback that doesn't depend on any of this. From a **root shell**, `$(id -u):$(id -g)` expands to `0:0`, silently turning the container back into root instead of your (non-root) uid — run this from your normal user shell, not as root (`sudo docker run …` is fine: the shell expands `$(id -u)` before `sudo` ever runs).

**`-e HTP_K8S_ADDR=:8080`.** Required for the remote/real-address-cluster and local-kind recipes — it's not optional the way it looks. Docker's `-p 127.0.0.1:8080:8080` forwards traffic to the *container's own* interface address, never to its loopback, so a container left on its loopback-only default would never see that traffic at all. The `-p` host-side binding is what actually restricts access, exactly as it does for the bare binary; the container just has to bind wider *inside its own network namespace* for that forwarding to reach it. Why this is a recipe flag rather than a wider image default: [ADR-0012](adr/0012-loopback-listen-address-by-default.md).

**Pointing the container at a local cluster.** A local cluster's kubeconfig usually points at `https://127.0.0.1:<port>` — meaningless from inside a bridge-networked container, which has its own loopback distinct from the host's. Two cases:

- **An existing local kind cluster:** `kind get kubeconfig --internal --name <cluster>` only *reads* the cluster's existing state — it's a generator, not a mutation. It writes a second, container-only kubeconfig to the file you redirect it to; your `~/.kube/config` and current `kubectl` context are untouched (verified: identical before/after, byte for byte). What differs is the server address inside it: the cluster's in-network hostname (`https://<cluster>-control-plane:6443`) instead of the externally-published `127.0.0.1:<port>` your normal kubeconfig has — `--network kind` (the Docker network `kind create cluster` already made, nothing extra to set up) is what makes that hostname resolve from the container.
- **Some other local cluster** (k3d, minikube with the Docker driver, Docker Desktop's built-in Kubernetes) has the same `127.0.0.1`-only problem but no `kind`-style in-network hostname to fall back on. The general fallback is `--network host`, which shares the host's network stack outright, so your normal kubeconfig's `127.0.0.1:<port>` resolves correctly from inside the container — but it also makes Docker's `-p` a no-op, which is why that recipe's `-e HTP_K8S_ADDR` value changes to `127.0.0.1:8080` (see [ADR-0012](adr/0012-loopback-listen-address-by-default.md) for why that has to be the app binding its own loopback rather than anything Docker-side). Verified directly: under `--network host`, that value binds loopback-only exactly like the native binary's own default — reachable at `localhost:8080`, unreachable from elsewhere on the network. Not verified against k3d/minikube/Docker Desktop specifically — none are set up in this project's own test environment — but the recipe follows from how `--network host` and Docker's `-p` interact, which doesn't depend on which tool created the cluster.

## Teardown

Stop the app (`Ctrl-C`, or `kill` its PID), then delete the cluster:

```bash
kind delete cluster --name htp-demo
```

That removes the cluster node container and everything seeded into it — nothing else
persists.

## Layer-3 authoritative video capture (feel-changing PRs)

ADR-0011 verifies motion/animation quality in three layers; the third — **one
authoritative video capture per feel-changing PR** (camera or animation
choreography, aesthetics) — is a **merge gate**, reviewed by a human, because
choreography and aesthetics are irreducibly human judgments no automated check
can certify. `task capture:record` produces that capture:

```bash
task capture:record
```

This builds the binary and spins up its own throwaway kind+KWOK cluster under
an **isolated kubeconfig** (`test/e2e/capture/out/<timestamp>/kubeconfig`, via
`$KUBECONFIG`) — it never reads or writes your default `~/.kube/config` or
touches its current-context at all, so it's safe to run alongside a cluster
you already have selected. It then starts the app with Demo Mode auto-flying
on a fixed seed, and:

- **captures** a raw CDP `Page.startScreencast` screen recording (JPEG
  quality 100, native resolution, every frame) instead of Playwright's
  built-in `recordVideo`. The built-in recorder's internal ffmpeg preset
  (`-deadline realtime -speed 8 -crf 8 -b:v 1M`, scaled to fit 800x800) is a
  fast/cheap preset for routine CI artifacts — fine for the ADR-0011 layer-2
  e2e suite, but it downscales below the capture viewport and compresses away
  exactly the fine roll/yaw micro-motion layer 3 exists to judge. It cannot
  carry a feel verdict.
- **encodes** the captured frames offline (not in real time) into a
  `libvpx`/VP8 `.webm` at ~7x the bitrate and 2.4x the frame rate of the
  built-in recorder's preset, with no downscale. `Page.startScreencast` has no
  frame-rate control — it delivers frames as fast as the renderer paints and
  the ack loop allows, and that rate varies run to run (5.6fps-29fps observed
  on the same machine across different captures). The encode step holds each
  captured frame for its true observed on-screen duration (expanded onto an
  exact 60fps timeline with cumulative rounding, so repeat counts never
  drift), which is what keeps the output's *playback speed* correct
  regardless of capture rate — a naive fixed-rate concatenation would produce
  a subtly wrong-speed video, which is precisely the kind of error that can
  silently corrupt a feel review without looking broken.
- **analyzes** the parallel pose trace (position + camera quaternion, sampled
  alongside every captured frame): the strongest turns (yaw-rate maxima),
  sustained yaw-rate saturation events (full-resolution finite difference
  thresholded at 0.98x the flight's max yaw rate, with samples within 0.3s
  merged into one cluster — required, or capture/async-evaluate jitter
  fragments one visually-continuous pan into dozens of meaningless blips),
  tower-proximity events, and a set of labeled interval stills. Yaw is
  derived from the *rendered* camera quaternion, deliberately independent of
  Demo Mode's internal deterministic pose-stream model
  (`web/src/scene/demoMode.ts`) — that independence is what makes the
  analysis evidence a feel review can trust, rather than a restatement of the
  model under test.

Output lands under `test/e2e/capture/out/<timestamp>/` by default: the
`.webm`, `pose-samples.json`, `pose-analysis.json`,
`tower-proximity-analysis.json`, `stills/` (labeled JPEGs), `stills-manifest.json`,
`towers.json`, and the isolated `kubeconfig` mentioned above. The raw JPEG
frame cache (596-755 MB observed for a 2-minute capture) is always deleted —
unconditionally, on every exit path, not just the success path, since it has
no value once written and this project has repeatedly leaked kind clusters,
app processes, and frame caches from ad-hoc capture scripts.
`test/e2e/capture/run.sh` runs its cleanup (app process, kind cluster, frame
cache) from a trap on normal exit *and* on interrupt (Ctrl-C/SIGTERM/SIGHUP),
and each step **verifies** its own result (checks the process/cluster is
actually gone, not just that a kill/delete command was issued) before
reporting success.

Override the defaults with `HTP_K8S_CAPTURE_*` env vars (seed, duration,
viewport, output directory, port, cluster name) — see the header comment in
`test/e2e/capture/run.sh` for the full list, e.g.:

```bash
HTP_K8S_CAPTURE_SEED=42 HTP_K8S_CAPTURE_DURATION_MS=60000 task capture:record
```

Every step except `capture.mjs` itself is runnable standalone with plain
`node`, against an existing capture directory: `analyze.mjs`, `proximity.mjs`,
and `stills.mjs` are pure-JSON, no cluster/app/browser/ffmpeg involved —
useful for re-running just the analysis on a prior clip, e.g. to validate a
change to the analysis math against a known result before trusting it on new
footage:

```bash
node test/e2e/capture/analyze.mjs --pose-samples path/to/pose-samples.json --label mylabel
```

`encode.mjs` is also standalone-runnable (it needs only the Playwright-bundled
ffmpeg, auto-detected from the Playwright browsers cache — override with
`FFMPEG_PATH` if yours lives somewhere nonstandard):

```bash
node test/e2e/capture/encode.mjs --out-dir path/to/capture/dir --output out.webm
```

`capture.mjs` is the one exception: it imports `@playwright/test`, which only
resolves via the `web/node_modules` symlink `run.sh` creates for the
duration of the capture step (see that script's comments) — invoke it
through `run.sh`/`task capture:record` rather than directly.

This tool is **not** part of the automated test suite and is never run in
CI — it is a manual step for whoever is preparing a feel-changing PR for
review, run once at the end (ADR-0011: capture video once, after iterating
against the fast layer-1 pose-stream math invariants — not as the iteration
loop itself).
