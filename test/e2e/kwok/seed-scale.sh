#!/usr/bin/env bash
#
# Seed a FULL-SCALE amount of KWOK-simulated data into a kind cluster — a
# qualitatively denser tier than the PR-blocking e2e job's cluster (that job
# uses the modest tier, seed.sh: 6 nodes / 30 pods), reserved for the nightly
# job (issue #29) and never run at PR time.
#
# Shares seed.sh's model (a KWOK controller layered onto the one real kind
# node; fake Nodes/Pods as ordinary API objects) and its vendored manifests
# (internal/testcluster/manifests/{kwok.yaml,stage-fast.yaml}), but a
# DELIBERATELY different, uneven pod distribution across nodes rather than
# seed.sh's flat round-robin — the point of this script isn't just "a lot of
# pods", it's a scene shaped to exercise #59's four-face Panel wrap and
# scene-wide height growth (docs/adr's ADR-0004, issue #29's acceptance
# criteria):
#
#   - node 0 ("hot"): HOT_POD_COUNT pods (default 260) — comfortably past
#     panelLayout.ts's ~34-pod single-face wrap threshold and ~132-pod
#     height-growth threshold (see that file's sceneRowsPerFace/
#     sceneTowerHeight), so this Tower visibly wraps across all four faces
#     and grows the WHOLE SCENE taller (to h ≈ 11.24 at this default — the
#     exact height PR #162's own manual verification used). NOT 420 (this
#     script's original default): issue #171's rehearsal found demoMode.ts's
#     climb-out mechanics (`MAX_CLIMB_GRADIENT`, a fixed world-units/second
#     climb rate that does NOT scale with the scene's grown roofline) cannot
#     always complete the ascent to the overview altitude band within one
#     overview episode's fixed waypoint budget once the roofline passes
#     roughly 3x the resting TOWER_HEIGHT (420 pods grows the scene to
#     h ≈ 18.24 ⇒ scale ≈ 3.04, and demo-mode-roofline.spec.ts's nightly
#     roofline-clearance guard was flaky at exactly that height across
#     repeated real runs). 260 pods keeps scale ≈ 1.87, well inside the
#     climb-out's budget, and is still comfortably past both thresholds
#     below. This is a genuine gap in demoMode.ts's PRE-EXISTING (unchanged
#     by this PR) altitude choreography, not a bug in this seed script —
#     recorded in docs/agents/findings.md; fixing the choreography itself is
#     out of this PR's scope (ADR-0011 motion-quality work has its own
#     build-metric/tune/pin/human-review loop).
#   - node 1 ("sparse"): SPARSE_POD_COUNT pods (default 3) — deliberately
#     tiny, so once the hot Tower forces scene-wide height growth, this
#     Tower sits at the SAME grown height with mostly unfilled faces rather
#     than being shorter (the property #29 flags as "most likely to look
#     wrong even when the math is right").
#   - the remaining nodes: a varied medium spread (MEDIUM_POD_MIN..MAX,
#     deterministic per node index, no RNG) so the scene reads as a real
#     varied cluster rather than two outlier Towers surrounded by empty
#     ones, and there's a real performance signal to sample.
#
# DEFAULTS AND WHY THEY'RE SMALLER THAN ADR-0004'S "50+ nodes, thousands of
# pods" ASPIRATION (issue #171 review finding): that figure was never
# actually rehearsed end to end before this workflow's first scheduled run,
# and doing so here found real problems at it (occlusion in a camera framing
# formula, a too-tight demo-mode-roofline.spec.ts timeout, a demoMode.ts
# climb-out that can't keep up with a very tall roofline — see HOT_POD_COUNT's
# own comment above — and an unverified 60-minute job budget against a
# ~3,900-object serial `kubectl apply`). The shipped default below —
# NODE_COUNT=15 (16 Towers with the real kind node), ~1,231 pods with these
# defaults — IS rehearsed end to end (a real kind+KWOK cluster, seeded from
# cold in well under 3 minutes, followed by the full `task web:e2e:nightly`
# suite, all passing, repeatedly) and is already a qualitatively different
# scale tier than the PR suite's 6 nodes/30 pods — comfortably past both the
# wrap and height-growth thresholds above. The larger, ADR-0004-aspirational
# scale (50 nodes, ~3,671 pods with these same per-node defaults) is still
# reachable, but only as a conscious, manually-triggered `workflow_dispatch`
# run (nightly.yml's `node_count` input) — never the unattended scheduled
# trigger — until it, too, is rehearsed end to end at that scale.
#
# All pods are created directly Running (no phase variety) — this script is
# about SCALE and LAYOUT, not phase-color coverage (seed.sh's modest tier
# already covers that WebGL-cheaply on every PR).
#
# Like seed.sh, this is a hard correctness gate: it asserts the intended end
# state (every fake node Ready, the total pod count present, the hot/sparse
# nodes carrying their intended counts) and exits non-zero if it isn't there
# within the timeout — the nightly job must not silently degrade to a
# thinner scene and report green.
#
# Requires: kubectl on PATH and a working KUBECONFIG.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MANIFESTS="${REPO_ROOT}/internal/testcluster/manifests"

NS="default"
POD_SELECTOR="app.kubernetes.io/managed-by=htp-k8s-e2e-seed-scale"
PAUSE_IMAGE="registry.k8s.io/pause:3.10"

# Overridable via env for local experimentation; the SCHEDULED nightly
# workflow trigger uses these defaults (see the header comment above for why
# NODE_COUNT is 15, not ADR-0004's 50+ aspiration). A manually-triggered
# `workflow_dispatch` run can override any of these to rehearse at a larger
# (or smaller) scale without editing this file.
NODE_COUNT="${HTP_K8S_SEED_SCALE_NODE_COUNT:-15}"
HOT_POD_COUNT="${HTP_K8S_SEED_SCALE_HOT_POD_COUNT:-260}"
SPARSE_POD_COUNT="${HTP_K8S_SEED_SCALE_SPARSE_POD_COUNT:-3}"
MEDIUM_POD_MIN="${HTP_K8S_SEED_SCALE_MEDIUM_POD_MIN:-40}"
MEDIUM_POD_RANGE="${HTP_K8S_SEED_SCALE_MEDIUM_POD_RANGE:-60}"

# Validate every knob is actually a non-negative integer BEFORE it reaches
# arithmetic (`((...))`, `%`) or `[ -lt ]` — an unset-but-non-numeric
# workflow_dispatch input (e.g. someone typos a word into the GitHub Actions
# "Run workflow" form) would otherwise fail deep inside this script with a
# bare, confusing "integer expression expected", and MEDIUM_POD_RANGE=0
# would divide-by-zero in the per-node `%` below. Fail fast, at the top, with
# a clear diagnostic naming the offending knob.
require_nonneg_int() {
  local name="$1" value="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ${name} must be a non-negative integer, got '${value}'" >&2
    exit 1
  fi
}
require_nonneg_int HTP_K8S_SEED_SCALE_NODE_COUNT "${NODE_COUNT}"
require_nonneg_int HTP_K8S_SEED_SCALE_HOT_POD_COUNT "${HOT_POD_COUNT}"
require_nonneg_int HTP_K8S_SEED_SCALE_SPARSE_POD_COUNT "${SPARSE_POD_COUNT}"
require_nonneg_int HTP_K8S_SEED_SCALE_MEDIUM_POD_MIN "${MEDIUM_POD_MIN}"
require_nonneg_int HTP_K8S_SEED_SCALE_MEDIUM_POD_RANGE "${MEDIUM_POD_RANGE}"

if [ "${NODE_COUNT}" -lt 3 ]; then
  echo "ERROR: NODE_COUNT must be at least 3 (hot + sparse + at least one medium node)" >&2
  exit 1
fi
if [ "${MEDIUM_POD_RANGE}" -lt 1 ]; then
  echo "ERROR: HTP_K8S_SEED_SCALE_MEDIUM_POD_RANGE must be at least 1 (used as a modulus below)" >&2
  exit 1
fi

log() { printf '\n=== [seed-kwok-scale] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. KWOK controller + fast stages (identical to seed.sh's steps 1-2 — see
#    that script for the full rationale). Safe to re-apply if a caller has
#    already run seed.sh against the same cluster (kubectl apply is
#    idempotent).
# ---------------------------------------------------------------------------
log "Applying KWOK controller (${MANIFESTS}/kwok.yaml)"
kubectl apply -f "${MANIFESTS}/kwok.yaml"
kubectl -n kube-system rollout status deployment/kwok-controller --timeout=180s

log "Applying KWOK fast stages"
kubectl wait --for=condition=Established --timeout=60s crd/stages.kwok.x-k8s.io
kubectl apply -f "${MANIFESTS}/stage-fast.yaml"

# ---------------------------------------------------------------------------
# 2. Fake nodes -> Towers. Same shape as seed.sh's, just NODE_COUNT of them.
# ---------------------------------------------------------------------------
log "Creating ${NODE_COUNT} fake nodes"
nodes_yaml=""
for ((i = 0; i < NODE_COUNT; i++)); do
  name="kwok-scale-node-${i}"
  nodes_yaml+="---
apiVersion: v1
kind: Node
metadata:
  name: ${name}
  annotations:
    kwok.x-k8s.io/node: fake
    node.alpha.kubernetes.io/ttl: \"0\"
  labels:
    type: kwok
    kubernetes.io/hostname: ${name}
    kubernetes.io/os: linux
    kubernetes.io/arch: amd64
spec:
  taints:
    - key: kwok.x-k8s.io/node
      value: fake
      effect: NoSchedule
status:
  allocatable:
    cpu: \"32\"
    memory: 256Gi
    pods: \"1000\"
  capacity:
    cpu: \"32\"
    memory: 256Gi
    pods: \"1000\"
  nodeInfo:
    architecture: amd64
    operatingSystem: linux
"
done
printf '%s' "${nodes_yaml}" | kubectl apply -f -
log "Waiting for ${NODE_COUNT} fake nodes to report Ready"
kubectl wait --for=condition=Ready node -l type=kwok --timeout=180s

# ---------------------------------------------------------------------------
# 3. Per-node pod counts: node 0 hot, node 1 sparse, the rest a deterministic
#    medium spread. Printed up front so the CI log states the plan before
#    the (slow, thousands-of-objects) apply below.
# ---------------------------------------------------------------------------
declare -a pod_count_for_node
total_pods=0
for ((i = 0; i < NODE_COUNT; i++)); do
  if [ "${i}" -eq 0 ]; then
    count="${HOT_POD_COUNT}"
  elif [ "${i}" -eq 1 ]; then
    count="${SPARSE_POD_COUNT}"
  else
    count=$(( MEDIUM_POD_MIN + (i * 17) % MEDIUM_POD_RANGE ))
  fi
  pod_count_for_node[i]="${count}"
  total_pods=$(( total_pods + count ))
done

log "Seed plan: ${NODE_COUNT} nodes, ${total_pods} pods total (node 0 'hot'=${HOT_POD_COUNT}, node 1 'sparse'=${SPARSE_POD_COUNT}, nodes 2..$((NODE_COUNT - 1)) medium ${MEDIUM_POD_MIN}-$((MEDIUM_POD_MIN + MEDIUM_POD_RANGE - 1)))"

# ---------------------------------------------------------------------------
# 4. Fake pods -> Panels, all created directly Running (see header comment
#    for why no phase variety here). Built as one big multi-doc YAML and
#    applied in one call, same pattern as seed.sh — kubectl processes each
#    document as its own API call under the hood, so this is a plain
#    (if long-running for thousands of pods) sequential apply, not a bulk
#    API trick.
# ---------------------------------------------------------------------------
log "Creating ${total_pods} fake pods across ${NODE_COUNT} nodes (this takes a few minutes at this scale)"
pods_yaml=""
pod_index=0
for ((i = 0; i < NODE_COUNT; i++)); do
  node="kwok-scale-node-${i}"
  count="${pod_count_for_node[i]}"
  for ((j = 0; j < count; j++)); do
    pods_yaml+="---
apiVersion: v1
kind: Pod
metadata:
  name: seed-scale-pod-${pod_index}
  namespace: ${NS}
  labels:
    app.kubernetes.io/managed-by: htp-k8s-e2e-seed-scale
    htp-k8s.io/seed-scale-node: \"${i}\"
spec:
  nodeName: ${node}
  containers:
    - name: app
      image: ${PAUSE_IMAGE}
"
    pod_index=$((pod_index + 1))
  done
done
printf '%s' "${pods_yaml}" | kubectl apply -f -

log "Waiting for all ${total_pods} pods to reach Running (KWOK pod-ready stage) — bounded to 10 minutes"
kubectl wait --for=jsonpath='{.status.phase}'=Running \
  pod -l "${POD_SELECTOR}" -n "${NS}" --timeout=600s

# ---------------------------------------------------------------------------
# 5. Summary + hard correctness gate. Node readiness was already asserted by
#    the blocking `kubectl wait` in step 2; pod phase was already asserted by
#    the blocking `kubectl wait` in step 4 (both fail this script outright,
#    under `set -e`, if they time out) — so what's left to verify here is the
#    thing neither wait proves: that the COUNT actually matches the plan
#    (a partially-failed apply can return 0 while creating fewer objects than
#    intended, and `kubectl wait` on a label selector with zero matches
#    trivially "succeeds" doing nothing).
# ---------------------------------------------------------------------------
log "Verifying seeded end state (hard gate)"
# A `kubectl get | wc -l` pipeline under `set -euo pipefail` aborts the whole
# script the instant `kubectl` itself fails (API server hiccup, etc.) —
# `wc -l` still exits 0, but pipefail propagates kubectl's own nonzero
# status, so `set -e` kills the script right here, BEFORE the informative
# "ERROR: seeded KWOK data did not reach..." diagnostics below ever print
# (issue #164's silent-abort class). Route every count through this helper
# so a real kubectl failure gets its own clear, dedicated diagnostic instead
# of a bare, unexplained abort.
count_matching() {
  local output
  if ! output=$(kubectl get "$@" --no-headers 2>&1); then
    echo "ERROR: 'kubectl get $*' failed:" >&2
    echo "${output}" >&2
    exit 1
  fi
  if [ -z "${output}" ]; then
    echo 0
  else
    printf '%s\n' "${output}" | wc -l
  fi
}
actual_total=$(count_matching pods -n "${NS}" -l "${POD_SELECTOR}")
actual_hot=$(count_matching pods -n "${NS}" -l "${POD_SELECTOR},htp-k8s.io/seed-scale-node=0")
actual_sparse=$(count_matching pods -n "${NS}" -l "${POD_SELECTOR},htp-k8s.io/seed-scale-node=1")
actual_nodes=$(count_matching nodes -l type=kwok)

problems=""
[ "${actual_nodes}" -eq "${NODE_COUNT}" ] || problems+="  fake nodes: want ${NODE_COUNT}, have ${actual_nodes}"$'\n'
[ "${actual_total}" -eq "${total_pods}" ] || problems+="  total pods: want ${total_pods}, have ${actual_total}"$'\n'
[ "${actual_hot}" -eq "${HOT_POD_COUNT}" ] || problems+="  hot node (0) pods: want ${HOT_POD_COUNT}, have ${actual_hot}"$'\n'
[ "${actual_sparse}" -eq "${SPARSE_POD_COUNT}" ] || problems+="  sparse node (1) pods: want ${SPARSE_POD_COUNT}, have ${actual_sparse}"$'\n'

if [ -n "${problems}" ]; then
  echo "ERROR: seeded KWOK data did not reach the expected end state:" >&2
  printf '%s' "${problems}" >&2
  exit 1
fi

echo "OK: ${actual_nodes} fake nodes Ready, ${actual_total} pods Running (hot node=${actual_hot}, sparse node=${actual_sparse})."
towers_total="$(count_matching nodes)"
echo "Node count (towers) = ${towers_total} (1 real kind node + ${NODE_COUNT} fake KWOK nodes)"

# Machine-readable copy of the same counts, for the nightly workflow's
# GITHUB_STEP_SUMMARY (issue #171): prints the ACTUAL seeded scale, not the
# knobs it was asked for, so a future drift between this header's documented
# defaults and what a run really seeded is visible on every run rather than
# only in a diff. A no-op outside GitHub Actions (GITHUB_OUTPUT unset).
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "actual_nodes=${actual_nodes}"
    echo "actual_towers=${towers_total}"
    echo "actual_total_pods=${actual_total}"
    echo "actual_hot_pods=${actual_hot}"
    echo "actual_sparse_pods=${actual_sparse}"
  } >>"${GITHUB_OUTPUT}"
fi
