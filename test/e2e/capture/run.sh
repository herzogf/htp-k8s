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
  # "${2:?...}" fails with a clear message if $2 is missing/empty, rather
  # than a flag with no value falling through to `set -u`'s raw "unbound
  # variable" error.
  case "$1" in
    --out-dir) OUT_DIR="${2:?--out-dir requires a value}"; shift 2 ;;
    --seed) SEED="${2:?--seed requires a value}"; shift 2 ;;
    --duration-ms) DURATION_MS="${2:?--duration-ms requires a value}"; shift 2 ;;
    --width) WIDTH="${2:?--width requires a value}"; shift 2 ;;
    --height) HEIGHT="${2:?--height requires a value}"; shift 2 ;;
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    --cluster-name) CLUSTER_NAME="${2:?--cluster-name requires a value}"; shift 2 ;;
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
#
# Taskfile.yml's `test` task points the same symlink at web/node_modules for
# its own (unrelated) reasons — the guarded create/remove lifecycle is
# shared via lib/node-modules-symlink.sh (issue #130) so the two callers
# can't drift out of sync with each other.
CAPTURE_NODE_MODULES_LINK="${SCRIPT_DIR}/node_modules"
WEB_NODE_MODULES="${REPO_ROOT}/web/node_modules"
# shellcheck source=lib/node-modules-symlink.sh
source "${SCRIPT_DIR}/lib/node-modules-symlink.sh"

log() { printf '\n=== [capture] %s\n' "$*"; }

log "Output directory: ${OUT_DIR}"
log "Kubeconfig (isolated to this run): ${KUBECONFIG}"

# Fail fast, BEFORE the ~2-minute build+cluster-create below, rather than
# opaquely mid-capture (issue #120 review) — see
# lib/node-modules-symlink.sh's check_capture_node_modules_prereqs for what
# this guards against.
check_capture_node_modules_prereqs "${CAPTURE_NODE_MODULES_LINK}" "${WEB_NODE_MODULES}"

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
CAPTURE_PID=""

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

# stop_capture: same verify+escalate discipline as stop_app, for the
# backgrounded capture.mjs (node + its headless Chromium child). Deliberately
# run FIRST in cleanup() (see below): a targeted `kill <run.sh PID>` (as
# opposed to Ctrl-C, which signals the whole process group) can otherwise
# leave capture.mjs running orphaned while the rest of cleanup proceeds —
# including delete_frame_cache's rm -rf of the very directory it's still
# writing frames into (issue #120 review).
#
# This only signals the tracked node PID — Chromium is a grandchild, spawned
# by Playwright underneath node, so the SIGKILL escalation two blocks down
# would (before issue #130) orphan it: SIGKILL cannot be caught, so node has
# no chance to close its browser on the way out, and an orphaned child is
# reparented rather than killed alongside it. capture.mjs now owns its own
# teardown instead of relying on this function reaching it in time: it
# installs SIGTERM/SIGINT handlers that close the browser (killing Chromium
# and all of its own subprocesses) before the process exits, so the SIGTERM
# sent below is normally enough on its own — the SIGKILL escalation here
# remains only as a last resort if that handler itself hangs.
stop_capture() {
  if [ -z "${CAPTURE_PID}" ]; then
    return 0
  fi
  if kill -0 "${CAPTURE_PID}" 2>/dev/null; then
    kill "${CAPTURE_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${CAPTURE_PID}" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "${CAPTURE_PID}" 2>/dev/null; then
      echo "WARNING: capture process ${CAPTURE_PID} did not exit on SIGTERM; sending SIGKILL" >&2
      kill -9 "${CAPTURE_PID}" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  if kill -0 "${CAPTURE_PID}" 2>/dev/null; then
    echo "ERROR: capture process ${CAPTURE_PID} is still alive after cleanup — giving up" >&2
    return 1
  fi
  CAPTURE_PID=""
  return 0
}

# delete_cluster: idempotent, and queries kind directly for the cluster's
# actual existence rather than gating on a "did we get far enough to set a
# flag" bookkeeping variable — a Ctrl-C during the 60-90s `kind create
# cluster` window could otherwise leave a partially-created cluster behind
# despite never reaching the line that used to set that flag (issue #120
# review).
#
# IMPORTANT: `kind get clusters` takes NO --kubeconfig flag (unlike `kind
# create`/`delete cluster`, which do and are correctly passed one below) —
# it enumerates clusters via Docker container labels, independent of any
# kubeconfig. An earlier version of this script passed --kubeconfig here;
# kind rejected it with "unknown flag" on stderr (swallowed by 2>/dev/null)
# and exited non-zero with EMPTY stdout, so the "is it still there?" grep
# never matched and this function silently reported success even when
# `kind delete cluster` had failed. `grep -Fqx` (fixed string, not `-qx`)
# because CLUSTER_NAME can contain "." — regex metacharacter otherwise.
delete_cluster() {
  if ! kind get clusters 2>/dev/null | grep -Fqx "${CLUSTER_NAME}"; then
    return 0
  fi
  kind delete cluster --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}" || true
  if kind get clusters 2>/dev/null | grep -Fqx "${CLUSTER_NAME}"; then
    echo "ERROR: kind cluster ${CLUSTER_NAME} is still present after delete" >&2
    return 1
  fi
  echo "Verified: kind cluster ${CLUSTER_NAME} is gone."
  return 0
}

# delete_kubeconfig: idempotent. Harmless once the cluster is gone (just a
# stale reference), but --out-dir can point somewhere that isn't
# git-ignored, and curating stills into docs/ from an out-dir is a plausible
# workflow — no reason to leave cluster CA/client cert material sitting on
# disk once we're done with it (issue #120 review).
delete_kubeconfig() {
  if [ -f "${KUBECONFIG}" ]; then
    rm -f "${KUBECONFIG}"
    echo "Deleted isolated kubeconfig (${KUBECONFIG})."
  fi
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

cleanup() {
  local status=$?
  log "Cleanup: tearing down the capture process, the app, the kind cluster, and the frame cache"
  # stop_capture FIRST: if capture.mjs is still running (targeted `kill
  # <run.sh PID>` rather than Ctrl-C — see stop_capture's comment), it must
  # stop writing into frames/ before delete_frame_cache below rm -rf's it.
  stop_capture || true
  remove_capture_node_modules_symlink "${CAPTURE_NODE_MODULES_LINK}"
  stop_app || true
  delete_cluster || true
  delete_kubeconfig
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
kubectl cluster-info
kubectl get nodes

log "Seeding KWOK nodes/pods for a populated scene"
"${REPO_ROOT}/test/e2e/kwok/seed.sh"

# ---------------------------------------------------------------------------
# 3. Launch the app with Demo Mode auto-starting on the given seed, and wait
#    for it to become healthy.
# ---------------------------------------------------------------------------
log "Starting the app on 127.0.0.1:${PORT} (Demo Mode auto-start, seed ${SEED})"
# Loopback-only (issue #127): this capture is driven entirely by a headless
# Chromium on THIS machine (capture.mjs, via BASE_URL=http://localhost:${PORT}
# above) — nothing about this tool needs the app reachable from elsewhere on
# the network, so there's no reason to bind wider than the app's own
# loopback-only default would already give it; being explicit here just
# keeps this script's intent legible without depending on that default.
HTP_K8S_DEMO=1 HTP_K8S_DEMO_SEED="${SEED}" "${REPO_ROOT}/bin/htp-k8s" -addr "127.0.0.1:${PORT}" \
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
create_capture_node_modules_symlink "${CAPTURE_NODE_MODULES_LINK}" "${WEB_NODE_MODULES}"
# Backgrounded (rather than run synchronously in the foreground) so
# CAPTURE_PID is tracked and stop_capture can kill it from cleanup() if this
# script is interrupted mid-capture (issue #120 review) — `wait` below still
# blocks until it finishes and propagates its exit status under `set -e`,
# so this has the same "capture failure aborts the script" behavior as a
# plain foreground invocation.
node "${SCRIPT_DIR}/capture.mjs" \
  --out-dir "${OUT_DIR}" \
  --duration-ms "${DURATION_MS}" \
  --base-url "${BASE_URL}" \
  --width "${WIDTH}" \
  --height "${HEIGHT}" &
CAPTURE_PID=$!
wait "${CAPTURE_PID}"
CAPTURE_PID=""
remove_capture_node_modules_symlink "${CAPTURE_NODE_MODULES_LINK}"

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
echo "(the isolated kubeconfig for this run is about to be deleted along with the cluster it pointed to — see below)"
