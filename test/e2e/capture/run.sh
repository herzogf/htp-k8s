#!/usr/bin/env bash
#
# ADR-0011 layer-3 authoritative video capture — the one-command orchestrator
# (issue #120). Builds the real single binary, spins up a throwaway kind+KWOK
# cluster (mirroring test/e2e/kwok/seed.sh / docs/running-locally.md), starts
# Demo Mode auto-flying against it, captures a raw CDP screencast at full
# fidelity, encodes it, runs the pose-trace analysis (strongest turns,
# yaw-rate saturation clusters, tower-proximity, labeled stills), and tears
# everything down — cluster, app process, and the raw JPEG frame cache (the
# thing genuinely worth deleting: 596-755 MB for a 2-minute capture, see the
# #118 capture notes referenced in issue #120).
#
# Usage:
#   ./test/e2e/capture/run.sh
#   ./test/e2e/capture/run.sh --out-dir /path/to/out --seed 42424242 \
#     --duration-ms 132000 --width 1600 --height 900 --port 8080
#
# Or via Task: `task capture:record` (see test/e2e/capture/Taskfile.yml),
# with the same knobs as HTP_K8S_CAPTURE_* env vars — see docs/running-locally.md.
#
# Run from the repository root (or anywhere; paths below are resolved
# relative to this script, matching test/e2e/kwok/seed.sh's convention).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# ---------------------------------------------------------------------------
# Parameters — CLI flags override HTP_K8S_CAPTURE_* env vars, which override
# the defaults below.
# ---------------------------------------------------------------------------
OUT_DIR="${HTP_K8S_CAPTURE_OUT_DIR:-${REPO_ROOT}/test/e2e/capture/out/$(date -u +%Y%m%dT%H%M%SZ)}"
SEED="${HTP_K8S_CAPTURE_SEED:-42424242}"
DURATION_MS="${HTP_K8S_CAPTURE_DURATION_MS:-132000}"
WIDTH="${HTP_K8S_CAPTURE_WIDTH:-1600}"
HEIGHT="${HTP_K8S_CAPTURE_HEIGHT:-900}"
PORT="${HTP_K8S_CAPTURE_PORT:-8080}"
CLUSTER_NAME="${HTP_K8S_CAPTURE_CLUSTER_NAME:-htp-k8s-capture}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --duration-ms) DURATION_MS="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

BASE_URL="http://localhost:${PORT}"
OUTPUT_WEBM="${OUT_DIR}/htp-k8s-demo-flight-seed${SEED}.webm"

mkdir -p "${OUT_DIR}"

# Isolated kubeconfig, scoped to this run (issue #120 review): `kind create
# cluster` would otherwise rewrite the user's default kubeconfig
# (~/.kube/config) and switch its current-context, and `kind delete cluster`
# does NOT restore whatever context was active before — it just removes the
# entry, leaving current-context unset. Pointing KUBECONFIG at a file inside
# OUT_DIR instead means this tool never touches the developer's own
# kubeconfig at all, and is safe to run alongside a cluster they already have
# selected. kubectl, test/e2e/kwok/seed.sh, and the app binary (client-go's
# default loading rules honor $KUBECONFIG) all inherit this via export.
export KUBECONFIG="${OUT_DIR}/kubeconfig"

# capture.mjs is the only script here that imports a package (@playwright/test,
# for its CDP-capable Chromium launcher). Node's ESM resolver looks for
# node_modules starting at the *importing file's own directory* and walking
# up — which never reaches web/node_modules from here, since test/e2e/capture
# isn't a descendant of web/. Rather than give this directory its own
# package.json + duplicate node_modules (which could drift from the pinned
# Chromium build web/e2e's Playwright suite uses), point a runtime-only
# symlink at web/node_modules just for the capture step. Git-ignored (see
# .gitignore); cleaned up below and by the trap.
CAPTURE_NODE_MODULES_LINK="${SCRIPT_DIR}/node_modules"

log() { printf '\n=== [capture] %s\n' "$*"; }

log "Output directory: ${OUT_DIR}"
log "Kubeconfig (isolated to this run): ${KUBECONFIG}"

# Fail fast, BEFORE the ~2-minute build+cluster-create below, rather than
# opaquely mid-capture (issue #120 review):
#   - web/node_modules must exist for the symlink trick above to work at all.
#   - CAPTURE_NODE_MODULES_LINK must not already exist as something other
#     than a symlink we manage — `ln -sfn` silently nests the new symlink
#     INSIDE a pre-existing real directory of that name instead of erroring,
#     which would both fail to expose @playwright/test and leave the trap's
#     `[ -L ... ]` cleanup guard unable to recognise (and thus not clean up)
#     the mess.
if [ ! -d "${REPO_ROOT}/web/node_modules" ]; then
  echo "ERROR: ${REPO_ROOT}/web/node_modules not found — run 'npm ci' in web/ (or 'task web:install') first." >&2
  exit 1
fi
if [ -e "${CAPTURE_NODE_MODULES_LINK}" ] && [ ! -L "${CAPTURE_NODE_MODULES_LINK}" ]; then
  echo "ERROR: ${CAPTURE_NODE_MODULES_LINK} exists and is not a symlink this tool manages — remove it manually and re-run." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Cleanup discipline (issue #120: "this project has repeatedly leaked
# clusters and app processes" — see docs/agents/findings.md, worktree &
# resource cleanup). Each teardown step is its own idempotent, VERIFYING
# function (not just "attempt and hope") — called explicitly once the
# capture is safely on disk (so encode/analyze don't hold the app/cluster
# alive for no reason) AND from the trap, so every exit path (normal,
# early-failure, or an interrupt) reaches the same real verification.
# ---------------------------------------------------------------------------
APP_PID=""
CLUSTER_CREATED=0

# stop_app: idempotent. Only clears APP_PID once the process is CONFIRMED
# gone (kill -0 fails) — never on faith just because a kill signal was sent.
# Escalates to SIGKILL if SIGTERM doesn't land within ~10s.
stop_app() {
  if [ -z "${APP_PID}" ]; then
    return 0
  fi
  if kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${APP_PID}" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "${APP_PID}" 2>/dev/null; then
      echo "WARNING: app process ${APP_PID} did not exit on SIGTERM; sending SIGKILL" >&2
      kill -9 "${APP_PID}" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  if kill -0 "${APP_PID}" 2>/dev/null; then
    echo "ERROR: app process ${APP_PID} is still alive after cleanup — giving up" >&2
    return 1
  fi
  echo "Verified: app process ${APP_PID} is gone."
  APP_PID=""
  return 0
}

# delete_cluster: idempotent. Only clears CLUSTER_CREATED once `kind get
# clusters` confirms the cluster is actually gone.
delete_cluster() {
  if [ "${CLUSTER_CREATED}" -ne 1 ]; then
    return 0
  fi
  kind delete cluster --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}" || true
  if kind get clusters --kubeconfig "${KUBECONFIG}" 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
    echo "ERROR: kind cluster ${CLUSTER_NAME} is still present after delete" >&2
    return 1
  fi
  echo "Verified: kind cluster ${CLUSTER_NAME} is gone."
  CLUSTER_CREATED=0
  return 0
}

# delete_frame_cache: idempotent, and — deliberately unlike an earlier
# version of this script — unconditional. The raw JPEG frame cache (596-755
# MB for a 2-minute capture) has no value once written; it must not survive
# ANY exit path, success or failure (issue #120 review: a failure between
# capture and the analysis steps must not leak it silently).
delete_frame_cache() {
  if [ ! -d "${OUT_DIR}/frames" ]; then
    return 0
  fi
  local reclaimed
  reclaimed="$(du -sh "${OUT_DIR}/frames" 2>/dev/null | cut -f1)"
  rm -rf "${OUT_DIR}/frames"
  if [ -d "${OUT_DIR}/frames" ]; then
    echo "ERROR: failed to delete ${OUT_DIR}/frames (still present, ~${reclaimed:-unknown size})" >&2
    return 1
  fi
  echo "Verified: raw JPEG frame cache deleted (reclaimed ${reclaimed:-an unknown amount})."
  return 0
}

# remove_symlink: idempotent. Only ever removes something WE created (a
# symlink at this exact path) — never a real directory, even one accidentally
# left at this path by something else.
remove_symlink() {
  if [ -L "${CAPTURE_NODE_MODULES_LINK}" ]; then
    rm -f "${CAPTURE_NODE_MODULES_LINK}"
  fi
}

cleanup() {
  local status=$?
  log "Cleanup: tearing down the app process, the kind cluster, and the frame cache"
  remove_symlink
  stop_app || true
  delete_cluster || true
  delete_frame_cache || true
  exit "${status}"
}
# INT/TERM/HUP (not just EXIT) so a Ctrl-C or a killed parent process still
# runs this — bash does not run EXIT-only traps on a signal that kills it
# outright, which is exactly the kind of interrupt that has leaked clusters
# from this project before.
trap cleanup EXIT INT TERM HUP

# ---------------------------------------------------------------------------
# 1. Build the real single binary (ADR-0001) — the same `task build` docs/
#    running-locally.md and web/playwright.config.ts's webServer use.
# ---------------------------------------------------------------------------
log "Building the binary (task build)"
( cd "${REPO_ROOT}" && task build )

# ---------------------------------------------------------------------------
# 2. Throwaway kind cluster + KWOK seed (ADR-0004 "modest" tier), matching
#    docs/running-locally.md's dev recipe and the E2E CI job.
# ---------------------------------------------------------------------------
log "Creating kind cluster '${CLUSTER_NAME}'"
kind create cluster --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}"
CLUSTER_CREATED=1
kubectl cluster-info
kubectl get nodes

log "Seeding KWOK nodes/pods for a populated scene"
"${REPO_ROOT}/test/e2e/kwok/seed.sh"

# ---------------------------------------------------------------------------
# 3. Launch the app with Demo Mode auto-starting on the given seed, and wait
#    for it to become healthy.
# ---------------------------------------------------------------------------
log "Starting the app on :${PORT} (Demo Mode auto-start, seed ${SEED})"
HTP_K8S_DEMO=1 HTP_K8S_DEMO_SEED="${SEED}" "${REPO_ROOT}/bin/htp-k8s" -addr ":${PORT}" \
  > "${OUT_DIR}/app.log" 2>&1 &
APP_PID=$!
echo "App PID: ${APP_PID}"

log "Waiting for ${BASE_URL}/healthz"
deadline=$((SECONDS + 60))
until curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "ERROR: app process exited before becoming healthy — see ${OUT_DIR}/app.log" >&2
    cat "${OUT_DIR}/app.log" >&2 || true
    exit 1
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "ERROR: app did not become healthy within timeout" >&2
    exit 1
  fi
  sleep 1
done
echo "App is healthy."

# ---------------------------------------------------------------------------
# 4. Capture: raw CDP screencast + pose trace + tower layout (capture.mjs).
# ---------------------------------------------------------------------------
log "Capturing (${DURATION_MS}ms @ ${WIDTH}x${HEIGHT})"
ln -sfn "${REPO_ROOT}/web/node_modules" "${CAPTURE_NODE_MODULES_LINK}"
node "${SCRIPT_DIR}/capture.mjs" \
  --out-dir "${OUT_DIR}" \
  --duration-ms "${DURATION_MS}" \
  --base-url "${BASE_URL}" \
  --width "${WIDTH}" \
  --height "${HEIGHT}"
remove_symlink

# App and cluster are no longer needed once the capture is on disk — stop
# them now (via the same verifying functions the trap uses, not a
# duplicated/weaker check) rather than waiting for the trap, so encode/
# analyze don't hold them alive for no reason. Both functions are idempotent,
# so it's safe for the trap to also run them at final exit.
log "Stopping the app and deleting the cluster (capture complete)"
stop_app
delete_cluster

# ---------------------------------------------------------------------------
# 5. Encode (offline, non-realtime — see encode.mjs's doc comment on why
#    Playwright's built-in recorder can't be used here).
# ---------------------------------------------------------------------------
log "Encoding ${OUTPUT_WEBM}"
node "${SCRIPT_DIR}/encode.mjs" --out-dir "${OUT_DIR}" --output "${OUTPUT_WEBM}"

# ---------------------------------------------------------------------------
# 6. Analysis: pose-trace (strongest turns + yaw-rate saturation clusters),
#    tower proximity, and labeled stills — the last of which must run BEFORE
#    the frame cache is deleted (the trap's delete_frame_cache, or the
#    explicit call below on the success path).
# ---------------------------------------------------------------------------
log "Analyzing pose trace"
node "${SCRIPT_DIR}/analyze.mjs" \
  --pose-samples "${OUT_DIR}/pose-samples.json" \
  --label "seed${SEED}-$(date -u +%Y%m%dT%H%M%SZ)" \
  --out "${OUT_DIR}/pose-analysis.json"

log "Analyzing tower proximity"
# 2.5 here is deliberately looser than proximity.mjs's own 1.6 CLI default —
# see that file's --near-threshold comment: this picks out more/broader
# "flew near a tower" moments for stills.mjs's picker below, not just
# genuinely tight squeezes.
node "${SCRIPT_DIR}/proximity.mjs" \
  --pose-samples "${OUT_DIR}/pose-samples.json" \
  --towers "${OUT_DIR}/towers.json" \
  --near-threshold 2.5 \
  --out "${OUT_DIR}/tower-proximity-analysis.json"

log "Selecting labeled stills"
node "${SCRIPT_DIR}/stills.mjs" \
  --out-dir "${OUT_DIR}" \
  --proximity "${OUT_DIR}/tower-proximity-analysis.json"

delete_frame_cache

log "Done."
echo "Video:      ${OUTPUT_WEBM}"
echo "Analysis:   ${OUT_DIR}/pose-analysis.json"
echo "Proximity:  ${OUT_DIR}/tower-proximity-analysis.json"
echo "Stills:     ${OUT_DIR}/stills/ (manifest: ${OUT_DIR}/stills-manifest.json)"
echo "Kubeconfig: ${KUBECONFIG} (now stale — the cluster it pointed at is deleted)"
