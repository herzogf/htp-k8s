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

// A single, predictable artifact location a future CI job (issue #8) can upload
// wholesale: Playwright drops each test's screenshot, video, and trace here.
const outputDir = path.join(webDir, 'e2e-results')

export default defineConfig({
  testDir: './e2e',
  outputDir,
  // No accidental `test.only` slipping through CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(webDir, 'playwright-report'), open: 'never' }],
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
