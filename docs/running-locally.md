# Running htp-k8s locally

This is the **developer / advanced-tester** recipe: build the app from source and
run it against a populated, multi-tower scene so you can explore behaviour the
automated tests deliberately don't judge — Demo Mode's camera choreography, how a
scene *feels*, how phase colours read (ADR-0004 scopes the e2e suite to mechanics,
not "does it feel cinematic"; ADR-0011 keeps aesthetic sign-off human).

If you just want to *use* a released build against a cluster you already have, see
the quickstart in the [README](../README.md) instead — this document is the fuller
build-from-source recipe.

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
| `-addr` | `HTP_K8S_ADDR` | Listen address; default `:8080`. See the port gotcha below. |
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

- **The `/ws` URL is baked in at build time.** The frontend defaults to
  `ws://localhost:8080/ws` (`DEFAULT_WS_URL` in `web/src/config.ts`), so **run on
  `:8080`** or the UI won't find the backend. To serve elsewhere, rebuild with the
  address baked in: `VITE_WS_URL=ws://host:port/ws task build` (the `/api` origin is
  derived from it, or overridden with `VITE_API_URL`). Passing `-addr` alone moves
  the server but not the URL the already-built frontend dials.
- **No cluster, no start.** The binary probes the cluster on startup and **exits
  non-zero if the API server is unreachable** (implemented for issue #9). A cluster
  that's reachable but where you can't list Nodes doesn't fail — it degrades to
  Namespace View Mode and keeps serving (ADR-0002). So a reachable kubeconfig
  (the kind cluster above, or any other) is required.
- **One lone Tower?** You skipped step 2 — without the seed you only see the single
  real kind node.

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

This builds the binary, spins up its own throwaway kind+KWOK cluster (separate
from any cluster you already have — it cleans up after itself and never
touches your kubeconfig's current context beyond the duration of the run),
starts the app with Demo Mode auto-flying on a fixed seed, and:

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
`tower-proximity-analysis.json`, `stills/` (labeled JPEGs) plus
`stills-manifest.json`, and `towers.json`. The raw JPEG frame cache
(596-755 MB observed for a 2-minute capture) is deleted automatically once
the encode and stills steps have consumed it — this project has repeatedly
leaked kind clusters, app processes, and frame caches from ad-hoc capture
scripts, so `test/e2e/capture/run.sh` verifies (not just attempts) that the
app process is gone, the kind cluster is deleted, and the frame cache is
reclaimed, on every exit path (success, failure, or interrupt).

Override the defaults with `HTP_K8S_CAPTURE_*` env vars (seed, duration,
viewport, output directory, port, cluster name) — see the header comment in
`test/e2e/capture/run.sh` for the full list, e.g.:

```bash
HTP_K8S_CAPTURE_SEED=42 HTP_K8S_CAPTURE_DURATION_MS=60000 task capture:record
```

The individual steps (`capture.mjs`, `encode.mjs`, `analyze.mjs`,
`proximity.mjs`, `stills.mjs`) are also runnable standalone against an
existing capture directory — useful for re-running just the analysis on a
prior clip, e.g. to validate a change to the analysis math against a known
result before trusting it on new footage:

```bash
node test/e2e/capture/analyze.mjs --pose-samples path/to/pose-samples.json --label mylabel
```

This tool is **not** part of the automated test suite and is never run in
CI — it is a manual step for whoever is preparing a feel-changing PR for
review, run once at the end (ADR-0011: capture video once, after iterating
against the fast layer-1 pose-stream math invariants — not as the iteration
loop itself).
