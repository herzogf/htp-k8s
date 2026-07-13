#!/usr/bin/env bash
#
# Seed a modest amount of KWOK-simulated data into the kind cluster the PR e2e
# job provisions, so the Playwright screenshot/video show a populated,
# multi-tower scene instead of the single real node's lone tower (issue #57,
# ADR-0004 "modest" tier — full scale is the nightly job, #29).
#
# This is the KWOK-controller-on-existing-kind-cluster model: the one real kind
# node stays real; fake Nodes/Pods are layered on top as ordinary API objects,
# managed by a KWOK controller that (per the vendored config's annotation
# selector) only touches the fake, annotated nodes. The app lists Nodes/Pods
# via the k8s API, so it sees these fake objects and builds one Tower per fake
# node plus colored Panels per pod phase.
#
# Reuses the vendored KWOK manifests from the #5 harness
# (internal/testcluster/manifests/{kwok.yaml,stage-fast.yaml}) so the controller
# image, RBAC, and lifecycle stages stay pinned in one place. The fake Node/Pod
# shape mirrors fakeNode()/fakePod() in internal/testcluster/kwok.go — kept in
# sync by hand, since a workflow shell step can't import the Go constants.
#
# Seeding is a HARD correctness gate for the e2e job (maintainer decision): a
# robust, populated test scene is required, so this script verifies the expected
# end state (all fake nodes Ready, all pods in their intended phases) and exits
# non-zero if it isn't fully there within the timeouts. The job does NOT run
# continue-on-error — a seeding failure fails the e2e job rather than silently
# degrading to the bare single-node scene.
#
# Requires: kubectl on PATH and a working KUBECONFIG (the e2e job exports one).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MANIFESTS="${REPO_ROOT}/internal/testcluster/manifests"

NS="default"
POD_SELECTOR="app.kubernetes.io/managed-by=htp-k8s-e2e-seed"
NODE_COUNT=6
POD_COUNT=30
PAUSE_IMAGE="registry.k8s.io/pause:3.10"

# Round-robin phase assignment. 7 phases over ${POD_COUNT} pods spreads a mix
# across all ${NODE_COUNT} nodes (7 and 6 are coprime, so no node gets a single
# phase). Yields 14 Running, 4 Pending, 4 Succeeded, 4 Failed, 4 CrashLoopBackOff.
PHASE_CYCLE=(running running running pending succeeded failed crashloop)

log() { printf '\n=== [seed-kwok] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. KWOK controller. The vendored ConfigMap already sets manageAllNodes:false
#    and manageNodesWithAnnotationSelector=kwok.x-k8s.io/node=fake, so the
#    controller manages ONLY the annotated fake nodes below and never fights
#    the real kubelet on the real kind node — no arg patching needed.
# ---------------------------------------------------------------------------
log "Applying KWOK controller (${MANIFESTS}/kwok.yaml)"
kubectl apply -f "${MANIFESTS}/kwok.yaml"
kubectl -n kube-system rollout status deployment/kwok-controller --timeout=180s

# ---------------------------------------------------------------------------
# 2. Fast lifecycle stages (drive Nodes -> Ready, Pods Pending -> Running
#    near-instantly). Wait for the Stage CRD to be Established first, or the
#    apply races the API server's discovery of the new kind.
# ---------------------------------------------------------------------------
log "Applying KWOK fast stages"
kubectl wait --for=condition=Established --timeout=60s crd/stages.kwok.x-k8s.io
kubectl apply -f "${MANIFESTS}/stage-fast.yaml"

# ---------------------------------------------------------------------------
# 3. Fake nodes -> Towers. One Tower per Node in the app's Node view mode. The
#    annotation is what the controller selects on; the matching NoSchedule taint
#    keeps the real scheduler from placing real pods here.
# ---------------------------------------------------------------------------
log "Creating ${NODE_COUNT} fake nodes"
nodes_yaml=""
for ((i = 0; i < NODE_COUNT; i++)); do
  name="kwok-node-${i}"
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
    pods: \"110\"
  capacity:
    cpu: \"32\"
    memory: 256Gi
    pods: \"110\"
  nodeInfo:
    architecture: amd64
    operatingSystem: linux
"
done
printf '%s' "${nodes_yaml}" | kubectl apply -f -
kubectl wait --for=condition=Ready node -l type=kwok --timeout=120s

# ---------------------------------------------------------------------------
# 4. Fake pods -> Panels. spec.nodeName binds each pod directly to a fake node
#    (bypassing the scheduler, standard for KWOK workloads), which is also how
#    the backend buckets pods onto their node's Tower. Create all pods Pending;
#    KWOK's pod-ready stage drives them to Running. Phase overrides come after
#    they settle (step 5).
# ---------------------------------------------------------------------------
log "Creating ${POD_COUNT} fake pods across ${NODE_COUNT} nodes"
pods_yaml=""
for ((i = 0; i < POD_COUNT; i++)); do
  node="kwok-node-$((i % NODE_COUNT))"
  phase="${PHASE_CYCLE[$((i % ${#PHASE_CYCLE[@]}))]}"
  pods_yaml+="---
apiVersion: v1
kind: Pod
metadata:
  name: seed-pod-${i}
  namespace: ${NS}
  labels:
    app.kubernetes.io/managed-by: htp-k8s-e2e-seed
    htp-k8s.io/seed-phase: ${phase}
spec:
  nodeName: ${node}
  containers:
    - name: app
      image: ${PAUSE_IMAGE}
"
done
printf '%s' "${pods_yaml}" | kubectl apply -f -

log "Waiting for pods to reach Running (KWOK pod-ready stage)"
kubectl wait --for=jsonpath='{.status.phase}'=Running \
  pod -l "${POD_SELECTOR}" -n "${NS}" --timeout=120s

# ---------------------------------------------------------------------------
# 5. Override a subset to varied phases via the status subresource, so once
#    #15's Panel rendering is on main the panels show a range of colors
#    (Running/Pending/Succeeded/Failed/CrashLoopBackOff). These target states no
#    longer match any fast-stage selector, so KWOK leaves them put:
#      * Pending  — phase back to Pending; the Ready=True condition KWOK already
#                   set keeps the pod-ready selector (Ready NotIn True) from
#                   re-matching, so it stays Pending.
#      * Succeeded/Failed — terminal phases; no stage re-drives them.
#      * CrashLoopBackOff — phase stays Running, but a container waiting on
#                   reason=CrashLoopBackOff is what the backend derives the
#                   phase from (internal/kube/panels.go: derivePhase).
# ---------------------------------------------------------------------------
patch_status() { # <seed-phase-label> <merge-patch-json>
  local label="$1" patch="$2" name
  for name in $(kubectl get pods -n "${NS}" -l "htp-k8s.io/seed-phase=${label}" -o name); do
    kubectl patch "${name}" -n "${NS}" --subresource=status --type=merge -p "${patch}" >/dev/null
  done
}

log "Overriding pod phases for a varied, colorful scene"
patch_status pending '{"status":{"phase":"Pending"}}'
patch_status succeeded '{"status":{"phase":"Succeeded","containerStatuses":[{"name":"app","image":"'"${PAUSE_IMAGE}"'","ready":false,"restartCount":0,"state":{"terminated":{"exitCode":0,"reason":"Completed"}}}]}}'
patch_status failed '{"status":{"phase":"Failed","reason":"Error","message":"seeded failed pod","containerStatuses":[{"name":"app","image":"'"${PAUSE_IMAGE}"'","ready":false,"restartCount":2,"state":{"terminated":{"exitCode":1,"reason":"Error"}}}]}}'
patch_status crashloop '{"status":{"containerStatuses":[{"name":"app","image":"'"${PAUSE_IMAGE}"'","ready":false,"restartCount":7,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"back-off restarting failed container"}}}]}}'

# ---------------------------------------------------------------------------
# 6. Summary for the CI log — how many towers and what phase spread the app
#    will see. (Node count includes the one real kind node.)
# ---------------------------------------------------------------------------
log "Seeded cluster state"
kubectl get nodes -o wide
echo
echo "Pod phase spread (as the backend will read it):"
kubectl get pods -n "${NS}" -l "${POD_SELECTOR}" \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,PHASE:.status.phase,WAITING:.status.containerStatuses[0].state.waiting.reason' \
  --sort-by='.spec.nodeName'
echo
echo "Node count (towers) = $(kubectl get nodes --no-headers | wc -l) (1 real kind node + ${NODE_COUNT} fake KWOK nodes)"

# ---------------------------------------------------------------------------
# 7. Hard correctness gate. `set -e` only catches commands that fail; a
#    `kubectl apply` can return 0 while nodes never go Ready or pods never reach
#    their phase. So assert the actual end state: exactly ${NODE_COUNT} fake
#    nodes Ready, and every seeded pod in the phase its label intends. Poll
#    briefly (KWOK reconciles asynchronously), then exit non-zero with a clear
#    message if the populated scene isn't fully there — which fails the e2e job.
# ---------------------------------------------------------------------------
log "Verifying seeded end state (hard gate)"

# Expected pod count per intended phase, derived from the same round-robin as
# the creation loop so it stays correct if the counts are ever retuned.
declare -A expected
for ((i = 0; i < POD_COUNT; i++)); do
  ph="${PHASE_CYCLE[$((i % ${#PHASE_CYCLE[@]}))]}"
  expected["${ph}"]=$(( ${expected["${ph}"]:-0} + 1 ))
done

# check_group <seed-phase-label> <want-phase> <want-waiting-reason-or-empty>:
# prints a diagnostic line if the pods carrying that label don't all show the
# intended phase (and, for crashloop, the CrashLoopBackOff container-waiting
# reason the backend derives on) in the expected number; prints nothing if OK.
check_group() {
  local label="$1" wphase="$2" wwait="$3" want total got
  want="${expected[${label}]:-0}"
  total=$(kubectl get pods -n "${NS}" -l "htp-k8s.io/seed-phase=${label}" --no-headers 2>/dev/null | wc -l)
  got=$(kubectl get pods -n "${NS}" -l "htp-k8s.io/seed-phase=${label}" \
          -o custom-columns='P:.status.phase,W:.status.containerStatuses[0].state.waiting.reason' \
          --no-headers 2>/dev/null \
        | awk -v p="${wphase}" -v w="${wwait}" \
            '{ wait = ($2 == "<none>" ? "" : $2) } $1 == p && wait == w { n++ } END { print n + 0 }')
  if [ "${total}" -ne "${want}" ] || [ "${got}" -ne "${want}" ]; then
    printf '  seed-phase=%s: want %d pods in phase=%s%s, have %d matching of %d\n' \
      "${label}" "${want}" "${wphase}" "${wwait:+ waiting=${wwait}}" "${got}" "${total}"
  fi
}

deadline=$(( SECONDS + 90 ))
while :; do
  problems=""

  # Nodes: exactly ${NODE_COUNT} fake nodes reporting Ready=True.
  ready=$(kubectl get nodes -l type=kwok \
            -o jsonpath='{range .items[*]}{range .status.conditions[?(@.type=="Ready")]}{.status}{"\n"}{end}{end}' 2>/dev/null \
          | grep -c '^True$' || true)
  if [ "${ready}" -ne "${NODE_COUNT}" ]; then
    problems+="  fake nodes Ready: want ${NODE_COUNT}, have ${ready}"$'\n'
  fi

  # Pods: every label group at its intended phase.
  problems+="$(check_group running   Running   '')"$'\n'
  problems+="$(check_group pending   Pending   '')"$'\n'
  problems+="$(check_group succeeded Succeeded '')"$'\n'
  problems+="$(check_group failed    Failed    '')"$'\n'
  problems+="$(check_group crashloop Running   CrashLoopBackOff)"$'\n'

  if [ -z "${problems//[$'\n\t ']/}" ]; then
    echo "OK: ${NODE_COUNT} fake nodes Ready and ${POD_COUNT} pods in their intended phases."
    break
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "ERROR: seeded KWOK data did not reach the expected end state within timeout:" >&2
    printf '%s' "${problems}" | grep . >&2 || true
    exit 1
  fi
  sleep 3
done
