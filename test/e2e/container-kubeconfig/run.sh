#!/usr/bin/env bash
#
# CI coverage for the published container image's kubeconfig fallback
# (issue #113): the ONE piece of that change that unit tests structurally
# cannot reach, since it lives in the real ko/Chainguard-static image's real
# non-root process, not in anything an unprivileged `go test` can fake.
# internal/kube/client_test.go already covers the decision function
# (usesContainerKubeconfigDefault) exhaustively; this script covers the
# container behavior itself: build the real image, actually `docker run` it
# three ways, and assert on the real, observable outcome each documents.
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
#   1. Default fallback: mount at /kube/config, no -e KUBECONFIG -> the app
#      starts and actually serves (GET /api/config), not merely "didn't
#      exit".
#   2. An explicit -e KUBECONFIG is never redirected to /kube/config: mounted
#      at a DIFFERENT path with a matching -e KUBECONFIG still serves; the
#      same env var pointed at a path with nothing mounted there fails with
#      the plain client-go error, not the container-default hint (proving
#      the retry truly never fires once KUBECONFIG is set).
#   3. A missing mount fails fast (exit 1) with the actionable diagnostic
#      naming /kube/config and the -v flag — the case most likely to rot
#      silently, since nobody manually re-checks an error message on every
#      base-image bump.
#
# KNOWN GAP this script works around, NOT one it hides (flagged for the
# maintainer, not fixed here — internal/kube/client.go and README are out of
# scope for this change): client-go's own clientcmd.WriteToFile — which is
# what `kind`/kubectl/most cloud-provider CLIs use to write a kubeconfig —
# defaults to mode 0600. The container's fixed non-root uid (65532, ko's
# Chainguard-static default) can't read a 0600 file it doesn't own; a plain
# `docker run -v "$HOME/.kube/config:/kube/config:ro"` — the README's exact
# documented invocation, unchanged by issue #113 — fails with "permission
# denied" against a completely standard kubeconfig on any real Linux Docker
# host (verified locally: a bare `docker run --user 65532:65532 -v
# 0600-file:/f:ro busybox cat /f` reproduces this with zero htp-k8s code
# involved). client.go itself handles this correctly (a permission error
# does not match errors.Is(err, fs.ErrNotExist), so it does NOT show the
# misleading "run with -v" hint for an already-mounted-but-unreadable file)
# — this is a docs/packaging gap, not a client.go bug. Tests 1 and 2 below
# mount a copy of KUBECONFIG with the group/other read bit added so they
# exercise the real, settled KUBECONFIG-resolution logic end-to-end (real
# non-root container, real network hop, real API server) without being
# blocked by this orthogonal permission gap. Test 3 (missing mount) needs no
# such workaround: a mount that isn't there at all fails on ErrNotExist
# regardless of permissions, so it reflects the documented command exactly.
set -euo pipefail

: "${IMAGE:?IMAGE must be set to a local image reference (e.g. from ko build --local)}"
: "${KUBECONFIG:?KUBECONFIG must be set to a working kubeconfig for a reachable cluster}"

log() { printf '\n=== [container-kubeconfig] %s\n' "$*"; }

# Track every container name we start so cleanup can force-remove all of them
# regardless of which subtest fails, and a scratch dir for the read-permission
# workaround copy (see the KNOWN GAP note above).
CONTAINERS=()
SCRATCH_DIR="$(mktemp -d)"

cleanup() {
  local rc=$?
  local name
  for name in "${CONTAINERS[@]:-}"; do
    [ -n "${name}" ] && docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  rm -rf "${SCRATCH_DIR}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# Readable copy of KUBECONFIG for tests 1/2 (see KNOWN GAP above) — a COPY,
# never the original, so this script never mutates a file it doesn't own.
READABLE_KUBECONFIG="${SCRATCH_DIR}/kubeconfig"
cp "${KUBECONFIG}" "${READABLE_KUBECONFIG}"
chmod 0644 "${READABLE_KUBECONFIG}"

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
# 1. Default fallback: -v ...:/kube/config:ro, NO -e KUBECONFIG. This is the
#    exact scenario issue #113 exists for.
# ---------------------------------------------------------------------------
log "Test 1: default fallback (mount /kube/config, no -e KUBECONFIG)"
name="htpk8s-fallback-default"
CONTAINERS+=("${name}")
docker run -d --name "${name}" --network host \
  -v "${READABLE_KUBECONFIG}:/kube/config:ro" \
  -e HTP_K8S_ADDR=:18081 \
  "${IMAGE}" >/dev/null

if ! wait_http_200 18081 /api/config 20; then
  echo "FAIL: default fallback did not serve GET /api/config within 20s. Container log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
resp="$(curl -sS -m 5 "http://127.0.0.1:18081/api/config")"
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
echo "OK: default fallback served a real GET /api/config response with no -e KUBECONFIG."

# ---------------------------------------------------------------------------
# 2a. An explicit KUBECONFIG still wins: mounted at a path OTHER than
#     /kube/config (nothing is mounted at /kube/config at all in this run),
#     with a matching -e KUBECONFIG. If the fallback ever redirected an
#     explicit KUBECONFIG to /kube/config, this would fail (nothing there).
# ---------------------------------------------------------------------------
log "Test 2a: explicit KUBECONFIG is honoured (mounted elsewhere, nothing at /kube/config)"
name="htpk8s-fallback-explicit"
CONTAINERS+=("${name}")
docker run -d --name "${name}" --network host \
  -v "${READABLE_KUBECONFIG}:/custom/kubeconfig:ro" \
  -e KUBECONFIG=/custom/kubeconfig \
  -e HTP_K8S_ADDR=:18082 \
  "${IMAGE}" >/dev/null

if ! wait_http_200 18082 /api/config 20; then
  echo "FAIL: explicit KUBECONFIG=/custom/kubeconfig did not serve GET /api/config within 20s. Container log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: an explicit KUBECONFIG mounted away from /kube/config still works."

# ---------------------------------------------------------------------------
# 2b. The converse: an explicit KUBECONFIG pointed at a path with NOTHING
#     mounted there must fail with the plain client-go error, never the
#     container-default hint — proving the retry genuinely never fires once
#     KUBECONFIG is set (matches
#     TestRestConfig_ExplicitKUBECONFIG_NeverRedirected's unit coverage, but
#     against the real container).
# ---------------------------------------------------------------------------
log "Test 2b: explicit KUBECONFIG with nothing mounted there is never redirected to /kube/config"
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
# 3. Priority case: a forgotten mount (no -v, no -e KUBECONFIG) fails fast
#    with the actionable diagnostic naming /kube/config and the -v flag —
#    the case most likely to rot silently across a base-image or ko change.
# ---------------------------------------------------------------------------
log "Test 3: missing mount fails fast with the actionable diagnostic"
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
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: a forgotten mount exits 1 with the documented -v hint."

log "All container kubeconfig fallback checks passed."
