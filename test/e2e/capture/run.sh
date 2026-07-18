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

mkdir -p "${OUT_DIR}"
log "Output directory: ${OUT_DIR}"

# ---------------------------------------------------------------------------
# Cleanup discipline (issue #120: "this project has repeatedly leaked
# clusters and app processes" — see docs/agents/findings.md, worktree &
# resource cleanup). Runs on ANY exit (success, failure, or interrupt), is
# idempotent, and VERIFIES rather than just attempts each teardown step, so a
# silent failure here doesn't look like a clean exit.
# ---------------------------------------------------------------------------
APP_PID=""
CLUSTER_CREATED=0

cleanup() {
  local status=$?
  log "Cleanup: tearing down the app process and the kind cluster"

  if [ -L "${CAPTURE_NODE_MODULES_LINK}" ]; then
    rm -f "${CAPTURE_NODE_MODULES_LINK}"
  fi

  if [ -n "${APP_PID}" ] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${APP_PID}" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "${APP_PID}" 2>/dev/null; then
      echo "WARNING: app process ${APP_PID} did not exit; sending SIGKILL" >&2
      kill -9 "${APP_PID}" 2>/dev/null || true
    fi
  fi
  if [ -n "${APP_PID}" ] && kill -0 "${APP_PID}" 2>/dev/null; then
    echo "ERROR: app process ${APP_PID} is still alive after cleanup" >&2
  elif [ -n "${APP_PID}" ]; then
    echo "Verified: app process ${APP_PID} is gone."
  fi

  if [ "${CLUSTER_CREATED}" -eq 1 ]; then
    kind delete cluster --name "${CLUSTER_NAME}" || true
    if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
      echo "ERROR: kind cluster ${CLUSTER_NAME} is still present after delete" >&2
    else
      echo "Verified: kind cluster ${CLUSTER_NAME} is gone."
    fi
  fi

  # The raw JPEG frame cache is the thing worth deleting on every path
  # (success or failure) — it's 596-755 MB for a 2-minute capture and has no
  # value once encode.mjs/stills.mjs have consumed it. Only delete it if
  # those steps ran (i.e. we're past the capture step and not aborting a
  # half-finished capture someone may want to inspect) — CAPTURE_DONE is set
  # right before this trap would otherwise be the only cleanup a failed
  # mid-capture run gets.
  if [ "${FRAMES_CONSUMED:-0}" -eq 1 ] && [ -d "${OUT_DIR}/frames" ]; then
    local reclaimed
    reclaimed="$(du -sh "${OUT_DIR}/frames" 2>/dev/null | cut -f1)"
    rm -rf "${OUT_DIR}/frames"
    if [ -d "${OUT_DIR}/frames" ]; then
      echo "ERROR: failed to delete ${OUT_DIR}/frames" >&2
    else
      echo "Verified: raw JPEG frame cache deleted (reclaimed ${reclaimed:-?})."
    fi
  fi

  exit "${status}"
}
trap cleanup EXIT

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
kind create cluster --name "${CLUSTER_NAME}"
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
rm -f "${CAPTURE_NODE_MODULES_LINK}"

# App and cluster are no longer needed once the capture is on disk — stop
# them now rather than waiting for the trap, so encode/analyze don't hold
# them alive for no reason. The trap's cleanup is idempotent (kill -0/kind
# get clusters guards), so this is safe to also run at exit.
log "Stopping the app and deleting the cluster (capture complete)"
kill "${APP_PID}" 2>/dev/null || true
wait "${APP_PID}" 2>/dev/null || true
APP_PID=""
kind delete cluster --name "${CLUSTER_NAME}" || true
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "ERROR: kind cluster ${CLUSTER_NAME} is still present after delete" >&2
  exit 1
fi
CLUSTER_CREATED=0
echo "Verified: app stopped and kind cluster deleted."

# ---------------------------------------------------------------------------
# 5. Encode (offline, non-realtime — see encode.mjs's doc comment on why
#    Playwright's built-in recorder can't be used here).
# ---------------------------------------------------------------------------
log "Encoding ${OUTPUT_WEBM}"
node "${SCRIPT_DIR}/encode.mjs" --out-dir "${OUT_DIR}" --output "${OUTPUT_WEBM}"

# ---------------------------------------------------------------------------
# 6. Analysis: pose-trace (strongest turns + yaw-rate saturation clusters),
#    tower proximity, and labeled stills — the last of which must run BEFORE
#    the frame cache is deleted below.
# ---------------------------------------------------------------------------
log "Analyzing pose trace"
node "${SCRIPT_DIR}/analyze.mjs" \
  --pose-samples "${OUT_DIR}/pose-samples.json" \
  --label "seed${SEED}-$(date -u +%Y%m%dT%H%M%SZ)" \
  --out "${OUT_DIR}/pose-analysis.json"

log "Analyzing tower proximity"
node "${SCRIPT_DIR}/proximity.mjs" \
  --pose-samples "${OUT_DIR}/pose-samples.json" \
  --towers "${OUT_DIR}/towers.json" \
  --near-threshold 2.5 \
  --out "${OUT_DIR}/tower-proximity-analysis.json"

log "Selecting labeled stills"
node "${SCRIPT_DIR}/stills.mjs" \
  --out-dir "${OUT_DIR}" \
  --proximity "${OUT_DIR}/tower-proximity-analysis.json"

# Frame cache is now fully consumed (encode + stills); the trap deletes it.
FRAMES_CONSUMED=1

log "Done."
echo "Video:     ${OUTPUT_WEBM}"
echo "Analysis:  ${OUT_DIR}/pose-analysis.json"
echo "Proximity: ${OUT_DIR}/tower-proximity-analysis.json"
echo "Stills:    ${OUT_DIR}/stills/ (manifest: ${OUT_DIR}/stills-manifest.json)"
