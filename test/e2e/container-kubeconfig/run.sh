#!/usr/bin/env bash
#
# CI coverage for the published container image's kubeconfig fallback
# (issue #113) AND its permission diagnostic (issue #128): the ONE piece of
# that behavior structurally unreachable from an unprivileged `go test` —
# it needs a real, permission-bearing kubeconfig file read by the real
# ko/Chainguard-static image's real non-root process, not anything an
# in-process unit test can fake. internal/kube/client_test.go already covers
# the decision function (usesContainerKubeconfigDefault) exhaustively; this
# script covers the container behavior itself: build the real image, actually
# `docker run` it several ways, and assert on the real, observable outcome
# each documents.
#
# Reuses the e2e job's already-provisioned kind cluster (ADR-0004's "don't
# spin up a redundant cluster" guidance) — it just needs a real, reachable
# API server and a kubeconfig for it, which that job already has by the time
# this runs. Requires: IMAGE (a local `ko build --local` image reference)
# and KUBECONFIG (a working kubeconfig for a reachable cluster) in the
# environment, plus docker and curl on PATH.
#
#   IMAGE=ko.local/htp-k8s-... KUBECONFIG=$HOME/.kube/config \
#     ./test/e2e/container-kubeconfig/run.sh
#
# Covers:
#   1. The documented recipe, run EXACTLY as documented, against KUBECONFIG
#      UNCHANGED (issue #128): mount at /kube/config with `--user
#      "$(id -u):$(id -g)"`, no -e KUBECONFIG -> the app starts and actually
#      serves (GET /api/config), not merely "didn't exit". This is the real
#      regression test for #128 — a kind/kubectl-written kubeconfig is mode
#      0600 (asserted below, so this test can't silently pass against a
#      permissive file), and prior to #128 this exact invocation, minus
#      --user, failed with "permission denied" on every real Linux Docker
#      host.
#   2. The permission diagnostic (issue #128): the SAME real 0600
#      KUBECONFIG, mounted at /kube/config, but WITHOUT --user — the failure
#      mode users actually hit (the pre-#128 documented recipe). Must fail
#      fast (exit 1) with a diagnostic naming --user "$(id -u):$(id -g)",
#      distinct from the missing-mount diagnostic in test 4.
#   3. An explicit -e KUBECONFIG is never redirected to /kube/config: mounted
#      at a DIFFERENT path (with --user, so a real 0600 file works there
#      too) with a matching -e KUBECONFIG still serves; the same env var
#      pointed at a path with nothing mounted there fails with the plain
#      client-go error, not the container-default hint (proving the retry
#      truly never fires once KUBECONFIG is set).
#   4. A missing mount fails fast (exit 1) with the actionable diagnostic
#      naming /kube/config and the -v flag — the case most likely to rot
#      silently, since nobody manually re-checks an error message on every
#      base-image bump.
#
# Formerly worked around #128 by mounting a chmod-644 COPY of KUBECONFIG
# rather than the real 0600 file (see the git history of this file for that
# version, and issue #129 for the gap it flagged). #128 fixed the underlying
# permission failure with `--user "$(id -u):$(id -g)"` (see README.md and
# internal/kube/client.go), so this script now exercises the real documented
# recipe against the real, unmodified, 0600 KUBECONFIG throughout — no copy,
# no chmod, nothing that could mask a real permission regression.
set -euo pipefail

: "${IMAGE:?IMAGE must be set to a local image reference (e.g. from ko build --local)}"
: "${KUBECONFIG:?KUBECONFIG must be set to a working kubeconfig for a reachable cluster}"

log() { printf '\n=== [container-kubeconfig] %s\n' "$*"; }

# This whole script's value rests on KUBECONFIG being genuinely
# owner-read-only, exactly as kind/kubectl/most cloud CLIs write it (issue
# #128's actual failure mode). Assert it rather than silently testing
# something weaker if the environment ever hands us a more permissive file.
kc_mode="$(stat -c '%a' "${KUBECONFIG}")"
if [ "${kc_mode}" != "600" ]; then
  echo "FAIL: KUBECONFIG (${KUBECONFIG}) is mode ${kc_mode}, expected 600 — this script exists to test the real permission failure/fix from issue #128 against a standard kind/kubectl-written kubeconfig; a more permissive file would let tests 1-3 pass for the wrong reason." >&2
  exit 1
fi

# Track every container name so cleanup can force-remove all of them
# regardless of which subtest fails. No scratch copy of KUBECONFIG is made
# anywhere in this script (see the header note above) — every test below
# mounts the real file.
CONTAINERS=()

cleanup() {
  local rc=$?
  local name
  for name in "${CONTAINERS[@]:-}"; do
    [ -n "${name}" ] && docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# --user "$(id -u):$(id -g)": issue #128's fix — makes the container read the
# real 0600 KUBECONFIG mount as the host user instead of its fixed non-root
# uid. Computed once so every "with --user" docker run below stays in sync.
HOST_USER="$(id -u):$(id -g)"

# port_is_free/pick_free_port: tests 1 and 3a run with --network host and
# actually bind, so a hardcoded port risks colliding with anything else
# already listening on the host — another job, another agent's app, a
# developer's own process (docker's own port-publish couldn't have picked
# one for us here, since --network host bypasses that entirely). Pick a
# random candidate in the ephemeral range and probe it with bash's own
# /dev/tcp (no extra tool dependency), retrying on collision.
port_is_free() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    return 1 # connected -> something is already listening
  fi
  return 0 # connection refused/failed -> free
}

pick_free_port() {
  local port attempt
  for attempt in $(seq 1 20); do
    port=$(((RANDOM % 20000) + 20000))
    if port_is_free "${port}"; then
      echo "${port}"
      return 0
    fi
  done
  echo "pick_free_port: could not find a free port after 20 attempts" >&2
  return 1
}

# wait_http_200 <port> <path> <timeout-seconds>: polls until the given
# localhost path answers 200, or fails loudly once the timeout elapses.
wait_http_200() {
  local port="$1" path="$2" timeout="$3" deadline
  deadline=$((SECONDS + timeout))
  while :; do
    if [ "$(curl -sS -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:${port}${path}" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      return 1
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# 1. The documented recipe, exactly as documented, against the real 0600
#    KUBECONFIG: -v ...:/kube/config:ro, --user "$(id -u):$(id -g)", no -e
#    KUBECONFIG. This is the exact scenario issues #113 and #128 exist for.
# ---------------------------------------------------------------------------
log "Test 1: documented recipe (--user + real 0600 KUBECONFIG, no -e KUBECONFIG)"
name="htpk8s-fallback-default"
CONTAINERS+=("${name}")
port1="$(pick_free_port)"
docker run -d --name "${name}" --network host \
  --user "${HOST_USER}" \
  -v "${KUBECONFIG}:/kube/config:ro" \
  -e HTP_K8S_ADDR=":${port1}" \
  "${IMAGE}" >/dev/null

if ! wait_http_200 "${port1}" /api/config 20; then
  echo "FAIL: documented recipe did not serve GET /api/config within 20s. Container log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
resp="$(curl -sS -m 5 "http://127.0.0.1:${port1}/api/config")"
case "${resp}" in
*'"demoSeed"'*) : ;;
*)
  echo "FAIL: GET /api/config did not return the expected AppConfig JSON, got: ${resp}" >&2
  exit 1
  ;;
esac
if ! docker logs "${name}" 2>&1 | grep -q "detected view mode:"; then
  echo "FAIL: container never logged a successful permission probe (detected view mode); the fallback path may not have actually reached the cluster. Log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: the documented recipe served a real GET /api/config response against a real 0600 kubeconfig."

# ---------------------------------------------------------------------------
# 2. Issue #128's permission diagnostic: the SAME real 0600 KUBECONFIG,
#    mounted at /kube/config, but WITHOUT --user — the pre-#128 documented
#    recipe, and the failure mode users actually hit. Must fail fast with a
#    diagnostic naming --user "$(id -u):$(id -g)", not the missing-mount
#    diagnostic (which would be actively misleading here — a file IS
#    mounted).
# ---------------------------------------------------------------------------
log "Test 2: permission diagnostic (real 0600 KUBECONFIG mounted, --user omitted)"
name="htpk8s-permission-denied"
CONTAINERS+=("${name}")
set +e
out="$(docker run --name "${name}" --network host \
  -v "${KUBECONFIG}:/kube/config:ro" \
  "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "FAIL: expected exit code 1 when --user is omitted against a 0600 kubeconfig, got ${rc}. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! echo "${out}" | grep -q "permission denied"; then
  echo "FAIL: expected a permission-denied failure (0600 kubeconfig, no --user), got a different error. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! echo "${out}" | grep -q -- '--user "\$(id -u):\$(id -g)"'; then
  echo "FAIL: permission diagnostic does not name --user \"\$(id -u):\$(id -g)\". Output:" >&2
  echo "${out}" >&2
  exit 1
fi
# Must NOT be confused with the missing-mount diagnostic (test 4) — a file IS
# mounted here, so that wording would be actively misleading.
if echo "${out}" | grep -q "run with -v"; then
  echo "FAIL: got the missing-mount diagnostic for a file that IS mounted (just unreadable). Output:" >&2
  echo "${out}" >&2
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: a 0600 kubeconfig mounted without --user fails with the actionable --user hint, distinct from the missing-mount diagnostic."

# ---------------------------------------------------------------------------
# 3a. An explicit KUBECONFIG still wins: mounted at a path OTHER than
#     /kube/config (nothing is mounted at /kube/config at all in this run),
#     with a matching -e KUBECONFIG and --user (so the real 0600 file is
#     readable). If the fallback ever redirected an explicit KUBECONFIG to
#     /kube/config, this would fail (nothing there).
# ---------------------------------------------------------------------------
log "Test 3a: explicit KUBECONFIG is honoured (mounted elsewhere, nothing at /kube/config)"
name="htpk8s-fallback-explicit"
CONTAINERS+=("${name}")
port3a="$(pick_free_port)"
docker run -d --name "${name}" --network host \
  --user "${HOST_USER}" \
  -v "${KUBECONFIG}:/custom/kubeconfig:ro" \
  -e KUBECONFIG=/custom/kubeconfig \
  -e HTP_K8S_ADDR=":${port3a}" \
  "${IMAGE}" >/dev/null

if ! wait_http_200 "${port3a}" /api/config 20; then
  echo "FAIL: explicit KUBECONFIG=/custom/kubeconfig did not serve GET /api/config within 20s. Container log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: an explicit KUBECONFIG mounted away from /kube/config still works."

# ---------------------------------------------------------------------------
# 3b. The converse: an explicit KUBECONFIG pointed at a path with NOTHING
#     mounted there must fail with the plain client-go error, never the
#     container-default hint — proving the retry genuinely never fires once
#     KUBECONFIG is set (matches
#     TestRestConfig_ExplicitKUBECONFIG_NeverRedirected's unit coverage, but
#     against the real container).
# ---------------------------------------------------------------------------
log "Test 3b: explicit KUBECONFIG with nothing mounted there is never redirected to /kube/config"
name="htpk8s-fallback-explicit-missing"
CONTAINERS+=("${name}")
set +e
out="$(docker run --name "${name}" --network host \
  -e KUBECONFIG=/custom/kubeconfig \
  "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -eq 0 ]; then
  echo "FAIL: expected a non-zero exit when KUBECONFIG points at a missing file, got 0. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
# The container-specific hint (see the "no kubeconfig found at ... or the
# container default" wording in internal/kube/client.go) must be ABSENT here —
# its presence would mean the retry fired despite KUBECONFIG being explicitly
# set, i.e. the explicit path got second-guessed. containerKubeconfigPath
# itself ("/kube/config", with the slash) can't appear by coincidence: the
# mounted-elsewhere path here is /custom/kubeconfig, one word, no slash before
# "config" (mirrors internal/kube/client_test.go's
# TestRestConfig_ExplicitKUBECONFIG_NeverRedirected, which checks the same
# thing against a bogus path).
if echo "${out}" | grep -q "container default"; then
  echo "FAIL: an explicit KUBECONFIG was redirected to the container default — it must never be second-guessed. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if echo "${out}" | grep -q "/kube/config"; then
  echo "FAIL: error unexpectedly names the container default path /kube/config; explicit KUBECONFIG must never be redirected. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: an explicit KUBECONFIG pointing at nothing mounted fails with the plain error, not the container hint."

# ---------------------------------------------------------------------------
# 4. Priority case: a forgotten mount (no -v, no -e KUBECONFIG) fails fast
#    with the actionable diagnostic naming /kube/config and the -v flag —
#    the case most likely to rot silently across a base-image or ko change.
#    Distinct from test 2's permission diagnostic (no file is mounted at all
#    here, vs. test 2's mounted-but-unreadable file).
#
#    No -e HTP_K8S_ADDR here (unlike tests 1/3a): kube.NewClients() runs
#    BEFORE the process ever attempts to bind a listen socket (see
#    cmd/htp-k8s/main.go's run()), so this container never reaches the
#    default :8080 either way — it can't collide with, or be masked by,
#    anything else already using that port on a shared host. The assertions
#    below are on the actual diagnostic text, not merely the exit code, so a
#    failure here can't accidentally pass "for the wrong reason" (e.g. an
#    unrelated port-bind failure producing the same exit code).
# ---------------------------------------------------------------------------
log "Test 4: missing mount fails fast with the actionable diagnostic"
name="htpk8s-fallback-missing-mount"
CONTAINERS+=("${name}")
set +e
out="$(docker run --name "${name}" --network host "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "FAIL: expected exit code 1 with no mount at all, got ${rc}. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! echo "${out}" | grep -q "/kube/config"; then
  echo "FAIL: diagnostic does not name /kube/config. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! echo "${out}" | grep -q -- "-v \$HOME/.kube/config:/kube/config:ro"; then
  echo "FAIL: diagnostic does not name the -v flag to run with. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if echo "${out}" | grep -q -- '--user'; then
  echo "FAIL: got the permission diagnostic for a mount that doesn't exist at all. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: a forgotten mount exits 1 with the documented -v hint."

log "All container kubeconfig fallback checks passed."
