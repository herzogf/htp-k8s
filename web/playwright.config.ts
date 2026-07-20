import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// This config lives in web/, but it drives the whole app: the real single
// binary (built by the root `task build`, ADR-0001) that serves the frontend
// and the /ws WebSocket endpoint. Resolve the repo root relative to this file
// so the harness works regardless of the caller's cwd.
const webDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webDir, '..')

// Port the built binary listens on for the e2e run. The frontend derives its
// /ws and /api target from the page's own origin (src/config.ts, issue #146),
// so the served page and its /ws endpoint stay on the same port automatically
// whatever port is chosen — no VITE_WS_URL needed. Overridable to dodge a busy
// 8080 locally.
const port = Number(process.env.HTP_K8S_E2E_PORT ?? 8080)
const baseURL = `http://localhost:${port}`

// Suite selection (issue #29): this ONE config drives both the PR-blocking
// suite (web/e2e, the modest ADR-0004 tier) and the nightly full-scale
// suite (web/e2e-nightly — thousands-of-pods KWOK scenes, never run against
// the shared PR seed since its specs assert exact Tower/Pod counts that a
// denser seed would destabilise). A second near-identical config file was
// deliberately rejected: the two suites share every other concern (build the
// real binary, point it at a kind cluster, capture screenshot/video/trace) —
// only testDir/outputDir/report-path and the per-test timeout budget differ,
// so branching on one env var here keeps them from drifting apart instead of
// needing to be kept in sync by hand across two files.
const nightly = process.env.HTP_K8S_E2E_SUITE === 'nightly'

// A single, predictable artifact location a future CI job (issue #8) can upload
// wholesale: Playwright drops each test's screenshot, video, and trace here.
// Nightly gets its own directory (never the PR suite's) so a local `task
// web:e2e` and `task web:e2e:nightly` run back-to-back don't clobber each
// other's artifacts.
const outputDir = path.join(webDir, nightly ? 'e2e-nightly-results' : 'e2e-results')

export default defineConfig({
  testDir: nightly ? './e2e-nightly' : './e2e',
  outputDir,
  // No accidental `test.only` slipping through CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The nightly suite drives a scene with thousands of Panels (instancing,
  // the per-Pod name-texture atlas, the wrap/height-growth layout math) —
  // meaningfully more render/layout work per frame than the PR suite's
  // modest ~30-Pod seed, so give it a larger per-test budget than
  // Playwright's 30s default rather than relying on every nightly spec to
  // remember `test.slow()`. `undefined` here is the PR suite's normal
  // default budget (unchanged behavior).
  timeout: nightly ? 120_000 : undefined,
  // The nightly suite runs serially (never Playwright's default parallel
  // workers): perf.spec.ts's frame-time sampling needs the CPU to itself to
  // mean anything — rehearsed locally, running the suite at the default
  // parallelism let concurrent heavy WebGL scenes from OTHER tests starve
  // it (observed ~2.7 FPS from contention alone, not the app). Serial
  // execution also keeps peak memory/CPU load down running several
  // thousands-of-Panels scenes back to back rather than at once, which
  // matters more here than the wall-clock cost of losing parallelism (this
  // job is scheduled, not PR-blocking). `undefined` here is Playwright's
  // normal default (parallel workers), unchanged for the PR suite.
  workers: nightly ? 1 : undefined,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: path.join(
          webDir,
          nightly ? 'playwright-nightly-report' : 'playwright-report',
        ),
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL,
    // Screenshots and video are the point of this project's e2e, not a
    // fallback (ADR-0004): they are the visual proof of behavior that lets a
    // change be trusted without a local run. Capture them on every test.
    screenshot: 'on',
    video: 'on',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the real single binary and launch it — the genuine full-system
    // check (ADR-0004). `task build` runs npm ci + vite build + the Go embed +
    // compile (root Taskfile).
    command: `task build && ./bin/htp-k8s -addr 127.0.0.1:${port}`,
    cwd: repoRoot,
    // Since issue #9 the binary fails startup unless it can reach a Kubernetes
    // cluster (client-go's default loading rules honor KUBECONFIG / ~/.kube/
    // config). In CI the e2e job provisions a kind cluster and exports
    // KUBECONFIG; pass it through so the launched binary connects to it. Locally
    // it forwards whatever cluster the developer has configured. `env` merges
    // with process.env, so an undefined KUBECONFIG here is a harmless no-op and
    // client-go still falls back to ~/.kube/config.
    env: { KUBECONFIG: process.env.KUBECONFIG ?? '' },
    url: `${baseURL}/healthz`,
    // The cold build (frontend + Go) can take a while; allow generous headroom.
    timeout: 300_000,
    // Never reuse a server already on the port: this harness's whole point is to
    // build and launch the *current* binary, so reusing a stale one (e.g. a dev
    // server) would silently test old code. `task build` is cheap on a warm tree
    // (go-task fingerprints skip an unchanged npm ci), so always rebuilding is
    // fine; a busy port surfaces as a clear failure rather than a false pass.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
