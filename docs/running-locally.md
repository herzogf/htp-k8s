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
*plus* the cluster's two DaemonSet pods (`kindnet`, `kube-proxy`). The fake nodes
have a `kwok.x-k8s.io/node=fake:NoSchedule` taint that keeps the scheduler from
placing ordinary pods there, but DaemonSets tolerate it and bind by `nodeName`,
so they land anyway — on every KWOK node alike.

## Controls

- **Free-fly:** click the canvas to grab pointer-lock, then `WASD` + mouse to fly;
  `Esc` releases the pointer.
- **Focus + detail:** click a Tower or a Panel to smoothly focus the camera on it and
  open its read-only Detail Popup (Panel popups include a short live log tail).
- **Demo Mode:** the toggle at the top-right starts/stops the automated cinematic
  canyon-tour flight (ADR-0010).

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
