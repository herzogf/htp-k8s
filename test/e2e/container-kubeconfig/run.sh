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
# API server, which that job already has by the time this runs. Requires:
# IMAGE (a local `ko build --local` image reference), CLUSTER_NAME (the name
# of that already-provisioned, reachable kind cluster), and KUBECONFIG (the
# real kubeconfig kind/kind-action wrote for it, e.g. $HOME/.kube/config —
# used only to assert the real-world 0600 premise below, never mounted into
# any container) in the environment, plus docker, curl, and kind on PATH.
#
#   IMAGE=ko.local/htp-k8s-... CLUSTER_NAME=htp-k8s-e2e KUBECONFIG=$HOME/.kube/config \
#     ./test/e2e/container-kubeconfig/run.sh
#
# Covers:
#   1. The documented recipe, run EXACTLY as documented, against a real 0600
#      kubeconfig (issue #128): mount at /kube/config with `--user
#      "$(id -u):$(id -g)"`, no -e KUBECONFIG -> the app starts and actually
#      serves (GET /api/config), not merely "didn't exit". This is the real
#      regression test for #128 — KUBECONFIG is asserted mode 0600 below, so
#      this test can't silently pass against a permissive file, and prior to
#      #128 this exact invocation, minus --user, failed with "permission
#      denied" on every real Linux Docker host.
#   2. The permission diagnostic (issue #128): the SAME real 0600
#      kubeconfig, mounted at /kube/config, but WITHOUT --user — the failure
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
#   5. The shipped IMAGE's *own default* (issue #127), exercised for the
#      first time by this script: run it exactly as an operator who forgot
#      `-e HTP_K8S_ADDR=:8080` would — bridge networking, a published host
#      port, no HTP_K8S_ADDR at all — and prove the published port is
#      unreachable (fail-closed), while independently proving the container
#      is genuinely alive and correctly loopback-bound (not merely dead),
#      then confirm the positive control: the identical invocation WITH
#      HTP_K8S_ADDR=:8080 serves 200. Every other subtest above always passes
#      HTP_K8S_ADDR explicitly, so none of them would notice IMAGE's own
#      default silently flipping to fail-open.
#
# Formerly worked around #128 by mounting a chmod-644 COPY of the kubeconfig
# rather than a real 0600 file (see the git history of this file for that
# version, and issue #129 for the gap it flagged). #128 fixed the underlying
# permission failure with `--user "$(id -u):$(id -g)"` (see README.md and
# internal/kube/client.go), so this script exercises the real documented
# recipe against a real 0600 kubeconfig throughout.
#
# NETWORKING (issue #127): this script does NOT use `--network host`. Under
# host networking, Docker's `-p` publish mapping is silently ignored — a
# container bound to a port under `--network host` is bound to that port on
# the HOST, across every interface, regardless of what `-p` says, which is
# exactly the exposure #127 exists to close. Instead every container here
# joins kind's own `kind` Docker network (`--network kind`, created
# automatically by `kind create cluster`) and is handed kind's *internal*
# kubeconfig (`kind get kubeconfig --internal`, which points at
# `https://<cluster>-control-plane:6443` — resolvable from another container
# on that same network — rather than the externally-published
# `https://127.0.0.1:<port>` a normal kubeconfig carries, which is
# meaningless from inside a bridge-networked container). Verified
# empirically against a real kind cluster and a real ko-built image while
# implementing #127: ordinary bridge networking + `-p 127.0.0.1:<port>:8080`
# reaches the cluster and serves end-to-end this way, with the *host*
# listener staying genuinely loopback-only (confirmed with `ss -ltn` and a
# failed connection attempt from the host's real LAN IP).
set -euo pipefail

: "${IMAGE:?IMAGE must be set to a local image reference (e.g. from ko build --local)}"
: "${CLUSTER_NAME:?CLUSTER_NAME must be set to the name of a reachable kind cluster}"
: "${KUBECONFIG:?KUBECONFIG must be set to a real, naturally-written kubeconfig for that cluster (e.g. \$HOME/.kube/config) — used only to assert the issue #128 premise below, not mounted into any container}"

log() { printf '\n=== [container-kubeconfig] %s\n' "$*"; }

# client-go's KUBECONFIG resolution accepts a colon-separated list of files
# (restConfig's doc comment in internal/kube/client.go calls this out
# explicitly), but the `stat` below needs exactly one real file to check the
# 0600 premise against. In CI, KUBECONFIG is always the single file
# kind-action wrote (build.yml sets it to just $HOME/.kube/config), so this
# never fires there — but a developer running the documented local invocation
# above (`KUBECONFIG=$HOME/.kube/config ... run.sh`) may already have a
# longer, colon-joined KUBECONFIG set in their own shell, which this script
# can't meaningfully check a single mode against. Fail with a clear,
# actionable message rather than a bare, confusing `stat: cannot stat` on a
# path containing a literal ':' (issue #129 — keeping this a hard failure
# rather than e.g. checking only the first entry via `${KUBECONFIG%%:*}` was
# a deliberate maintainer call: that would silently stat the wrong file and
# weaken the #128 0600 premise this script exists to check).
case "${KUBECONFIG}" in
*:*)
  echo "FAIL: KUBECONFIG (${KUBECONFIG}) is a colon-separated list of files. This script needs a single kubeconfig file to check the issue #128 permission premise against — re-run with KUBECONFIG set to just the one file kind wrote (e.g. KUBECONFIG=\$HOME/.kube/config)." >&2
  exit 1
  ;;
esac

# This whole script's value rests on a real kind/kubectl-written kubeconfig
# being genuinely owner-read-only (issue #128's actual failure mode) — assert
# that against KUBECONFIG, the kubeconfig kind/kind-action actually wrote via
# its normal client-go path (clientcmd.WriteToFile, mode 0600), rather than
# against a file THIS script chmods itself below (asserting a self-imposed
# mode right after imposing it is a no-op that can never fail — caught in
# review of an earlier version of this script; this checks the real,
# independently-produced artifact instead).
kc_mode="$(stat -c '%a' "${KUBECONFIG}")"
if [ "${kc_mode}" != "600" ]; then
  echo "FAIL: KUBECONFIG (${KUBECONFIG}) is mode ${kc_mode}, expected 600 — this script exists to test the real permission failure/fix from issue #128 against a standard kind/kubectl-written kubeconfig; a more permissive file would mean the environment itself no longer reflects the real-world case this script is for." >&2
  exit 1
fi

# Track every container name, and the scratch dir below, so cleanup can
# remove them regardless of which subtest fails. Both declared AND the trap
# installed before anything that could need cleaning up is created — a
# failure between "mktemp succeeds" and "the trap line runs" would otherwise
# leak the scratch dir (and, worse, the kubeconfig about to be written into
# it) with no cleanup registered to catch it.
CONTAINERS=()
SCRATCH_DIR=""

cleanup() {
  local rc=$?
  local name
  for name in "${CONTAINERS[@]:-}"; do
    [ -n "${name}" ] && docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  [ -n "${SCRATCH_DIR}" ] && rm -rf "${SCRATCH_DIR}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# kind's *internal* kubeconfig — see the NETWORKING note above for why this,
# not the externally-published one, is what a container on the `kind`
# network needs. Created AFTER the trap above is installed (so a failure
# here still gets cleaned up) and written with `umask 077` wrapping the
# redirect itself, rather than a default-mode write followed by a separate
# `chmod 600`: `kind get kubeconfig --internal` writes to stdout with no
# fixed mode, and a plain `> file` would briefly leave a real cluster
# credential file at the shell's ambient (often world-readable) umask before
# a later chmod tightened it — the umask subshell means the file is 0600
# from its very first byte, no window at all. (No follow-up mode assertion
# here — asserting a mode this same block just imposed can never fail; the
# KUBECONFIG assertion above is what actually proves the 0600 premise, against
# an independently-written real kubeconfig.)
SCRATCH_DIR="$(mktemp -d)"
INTERNAL_KUBECONFIG="${SCRATCH_DIR}/kubeconfig-internal"
( umask 077 && kind get kubeconfig --internal --name "${CLUSTER_NAME}" > "${INTERNAL_KUBECONFIG}" )

# --user "$(id -u):$(id -g)": issue #128's fix — makes the container read the
# real 0600 kubeconfig mount as the host user instead of its fixed non-root
# uid. Computed once so every "with --user" docker run below stays in sync.
HOST_USER="$(id -u):$(id -g)"

# port_is_free/pick_free_port: tests 1 and 3a publish the container's fixed
# internal :8080 (see the NETWORKING note above and their -e
# HTP_K8S_ADDR=:8080, matching the documented recipe exactly) to a HOST port
# via `-p 127.0.0.1:<port>:8080`, so a hardcoded port risks colliding with
# anything else already listening on the host — another job, another agent's
# process, a developer's own process. Pick a random candidate and probe it
# with bash's own /dev/tcp (no extra tool dependency), retrying on collision.
# Candidates are drawn from 20000-32767, deliberately kept BELOW Linux's
# default ephemeral port range (32768-60999, net.ipv4.ip_local_port_range):
# the probe-then-bind below is inherently TOCTOU-racy (nothing stops another
# process claiming the port between the probe and `docker run`'s bind), and
# picking from the ephemeral range would widen that race further by
# competing with every outbound connection the host makes in the meantime.
port_is_free() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    return 1 # connected -> something is already listening
  fi
  return 0 # connection refused/failed -> free
}

pick_free_port() {
  local port attempt
  for attempt in $(seq 1 20); do
    port=$(((RANDOM % 12768) + 20000)) # 20000-32767, see the note above
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

# wait_log_contains <container> <pattern> <timeout-seconds>: polls the
# container's log for a fixed grep pattern, or fails once the timeout
# elapses. Used by Test 5 to positively confirm the process reached its
# startup log line (proof of "correctly bound to loopback", not merely
# "the port didn't answer" — see that test's header comment for why the
# distinction matters).
#
# Captures `docker logs` into a variable FIRST, then greps the variable via a
# here-string, rather than `docker logs ... | grep -q ...`: under this
# script's `set -o pipefail` (line 85), a live pipe into `grep -q` is a real
# bug, not a style choice — `grep -q` exits the instant it finds a match,
# which can close the pipe's read end while `docker logs` still has buffered
# output left to write; the resulting SIGPIPE gives `docker logs` exit 141,
# and pipefail then reports the WHOLE pipeline as failed even though grep
# genuinely matched. Racy (only fires depending on scheduling/buffering), so
# it can pass for a long time before failing on a real match — see the git
# history of this function for the concrete case that surfaced it. A
# here-string has no pipe at all, so there is nothing for grep's early exit
# to race against.
wait_log_contains() {
  local name="$1" pattern="$2" timeout="$3" deadline logs
  deadline=$((SECONDS + timeout))
  while :; do
    logs="$(docker logs "${name}" 2>&1)"
    if grep -q -- "${pattern}" <<<"${logs}"; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      return 1
    fi
    sleep 1
  done
}

# container_is_running <container>: true iff docker reports the container as
# currently Running. Used by Test 5 alongside wait_log_contains — together
# they positively prove the process is alive and past its bind step, rather
# than inferring that from the mere absence of a symptom.
container_is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# ---------------------------------------------------------------------------
# 1. The documented recipe, exactly as documented, against the real 0600
#    KUBECONFIG: -v ...:/kube/config:ro, --user "$(id -u):$(id -g)", no -e
#    KUBECONFIG. This is the exact scenario issues #113 and #128 exist for.
# ---------------------------------------------------------------------------
log "Test 1: documented recipe (--user + real 0600 kubeconfig, no -e KUBECONFIG)"
name="htpk8s-fallback-default"
CONTAINERS+=("${name}")
port1="$(pick_free_port)"
docker run -d --name "${name}" --network kind \
  --user "${HOST_USER}" \
  -p "127.0.0.1:${port1}:8080" \
  -v "${INTERNAL_KUBECONFIG}:/kube/config:ro" \
  -e HTP_K8S_ADDR=:8080 \
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
# Captured first, then matched via a here-string rather than piped straight
# into `grep -q` — see wait_log_contains's header comment above for why a
# live `docker logs | grep -q` pipeline is a real bug under this script's
# `set -o pipefail`, not just a style preference. Capturing once here also
# means the failure branch below can reuse the same log text instead of
# calling `docker logs` a second time.
#
# This assignment is a top-level statement (unlike wait_log_contains's,
# which only ever runs inside an `if !` condition and so has `set -e`
# suppressed by the shell around it) — a failing `docker logs` here would
# otherwise trip `set -e` and exit immediately, with docker's own error text
# silently swallowed inside `logs` (folded in via 2>&1) rather than printed.
# The explicit `|| { ... }` below prints that text and fails loudly instead,
# so a `docker logs` failure can't regress into exactly the silent-failure
# class this PR exists to remove.
logs="$(docker logs "${name}" 2>&1)" || {
  echo "FAIL: docker logs ${name} failed. Output:" >&2
  echo "${logs}" >&2
  exit 1
}
if ! grep -q "detected view mode:" <<<"${logs}"; then
  echo "FAIL: container never logged a successful permission probe (detected view mode); the fallback path may not have actually reached the cluster. Log:" >&2
  echo "${logs}" >&2
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
log "Test 2: permission diagnostic (real 0600 kubeconfig mounted, --user omitted)"
name="htpk8s-permission-denied"
CONTAINERS+=("${name}")
set +e
out="$(docker run --name "${name}" --network kind \
  -v "${INTERNAL_KUBECONFIG}:/kube/config:ro" \
  "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "FAIL: expected exit code 1 when --user is omitted against a 0600 kubeconfig, got ${rc}. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -q "permission denied" <<<"${out}"; then
  echo "FAIL: expected a permission-denied failure (0600 kubeconfig, no --user), got a different error. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -q -- '--user "\$(id -u):\$(id -g)"' <<<"${out}"; then
  echo "FAIL: permission diagnostic does not name --user \"\$(id -u):\$(id -g)\". Output:" >&2
  echo "${out}" >&2
  exit 1
fi
# Must NOT be confused with the missing-mount diagnostic (test 4) — a file IS
# mounted here, so that wording would be actively misleading.
if grep -q "run with -v" <<<"${out}"; then
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
docker run -d --name "${name}" --network kind \
  --user "${HOST_USER}" \
  -p "127.0.0.1:${port3a}:8080" \
  -v "${INTERNAL_KUBECONFIG}:/custom/kubeconfig:ro" \
  -e KUBECONFIG=/custom/kubeconfig \
  -e HTP_K8S_ADDR=:8080 \
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
out="$(docker run --name "${name}" --network kind \
  -e KUBECONFIG=/custom/kubeconfig \
  "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -eq 0 ]; then
  echo "FAIL: expected a non-zero exit when KUBECONFIG points at a missing file, got 0. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
# Positive proof of life FIRST (issue #129): the two checks below only assert
# the ABSENCE of certain strings, so they'd pass just as well if the
# container failed early for some unrelated reason (a broken image, a
# missing binary, docker itself refusing to start it) — neither string would
# be present then either, and the subtest would prove nothing. Assert
# affirmatively that the real client-go resolution actually ran and produced
# exactly the plain "empty config" error restConfig's non-retry branch wraps
# (verified against a real run of internal/kube.restConfig() with
# KUBECONFIG set to this same nonexistent path) — proof this container
# genuinely reached and exercised the code path under test, not merely that
# two unrelated strings happen to be missing from whatever it did output.
#
# Issue #129 itself suggested `grep -q /custom/kubeconfig` here. That path
# deliberately does NOT appear in the error and can't be used: KUBECONFIG
# feeds client-go's Precedence chain, not its ExplicitPath, and
# clientcmd's loader silently skips missing Precedence entries rather than
# naming them (k8s.io/client-go/tools/clientcmd/loader.go, Load()) — so the
# chain ends up empty and clientcmd reports the same path-free
# ErrEmptyConfig used above, never the file's own path. Confirmed against a
# real build (see internal/kube/client_test.go's
# TestRestConfig_ExplicitKUBECONFIG_NeverRedirected, which asserts this same
# text); the issue's literal suggestion would have been a permanently-failing
# assertion, not a stronger one.
if ! grep -q "no configuration has been provided" <<<"${out}"; then
  echo "FAIL: did not get the expected plain client-go empty-config error — the container may have failed for an unrelated reason before ever reaching the KUBECONFIG resolution this test exercises. Output:" >&2
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
if grep -q "container default" <<<"${out}"; then
  echo "FAIL: an explicit KUBECONFIG was redirected to the container default — it must never be second-guessed. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if grep -q "/kube/config" <<<"${out}"; then
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
out="$(docker run --name "${name}" --network kind "${IMAGE}" 2>&1)"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "FAIL: expected exit code 1 with no mount at all, got ${rc}. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -q "/kube/config" <<<"${out}"; then
  echo "FAIL: diagnostic does not name /kube/config. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -q -- "-v \$HOME/.kube/config:/kube/config:ro" <<<"${out}"; then
  echo "FAIL: diagnostic does not name the -v flag to run with. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
if grep -q -- '--user' <<<"${out}"; then
  echo "FAIL: got the permission diagnostic for a mount that doesn't exist at all. Output:" >&2
  echo "${out}" >&2
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: a forgotten mount exits 1 with the documented -v hint."

# ---------------------------------------------------------------------------
# 5. The shipped IMAGE's own default (issue #127): under bridge networking
#    with a published host port and NO HTP_K8S_ADDR at all — the exact thing
#    every subtest above deliberately avoids testing, by always passing
#    HTP_K8S_ADDR=:8080 itself. The whole security argument for the
#    container recipe (README.md, .goreleaser.yaml's release footer) rests
#    on IMAGE defaulting to loopback-only, so that forgetting the flag fails
#    CLOSED (published port unreachable) rather than OPEN (published port
#    serving traffic). Nothing before this point in the file exercises that
#    default; it's asserted only in prose.
#
#    5a proves the negative (published port unreachable) is NOT the vacuous
#    "the container might just be dead" case: `docker inspect` must report
#    it Running, AND its own log must name the loopback bind, both checked
#    independently of the port probe. A subtest that only checked
#    unreachability would pass identically if the binary crashed on
#    startup — see this file's header comment on why that shape has burned
#    this script three times already.
#
#    5b is the positive control the negative is meaningless without: the
#    IDENTICAL invocation, differing only by adding -e HTP_K8S_ADDR=:8080,
#    must serve 200. Without 5b, 5a's failure could just as easily mean
#    "the API server was unreachable" or "the port picker collided" as
#    "the loopback default did its job".
# ---------------------------------------------------------------------------
log "Test 5a: IMAGE's own default (no HTP_K8S_ADDR) is fail-closed under bridge networking"
name="htpk8s-image-default-loopback"
CONTAINERS+=("${name}")
port5="$(pick_free_port)"
docker run -d --name "${name}" --network kind \
  --user "${HOST_USER}" \
  -p "127.0.0.1:${port5}:8080" \
  -v "${INTERNAL_KUBECONFIG}:/kube/config:ro" \
  "${IMAGE}" >/dev/null

# Positive proof of life FIRST: the process must reach and log its loopback
# bind line (cmd/htp-k8s/main.go's logListenAddr/isLoopbackAddr) within a
# generous startup window. If this never appears, the container either
# crashed or is hung before binding — a real failure, but a DIFFERENT one
# from "the loopback default leaked traffic", so it's reported distinctly
# from the port-unreachability check below rather than folded into it.
if ! wait_log_contains "${name}" "bound to loopback only" 20; then
  echo "FAIL: container never logged a loopback bind within 20s — IMAGE's own default may not be loopback-only any more, or the container failed to start. Log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
if ! container_is_running "${name}"; then
  echo "FAIL: container logged a loopback bind but is not Running (crashed immediately after logging?). Log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi

# Now the actual security assertion: the published host port must be
# unreachable. Docker's `-p 127.0.0.1:<port>:8080` maps to the container's
# OWN interface, not its loopback — a process bound to 127.0.0.1 inside the
# container never receives that traffic, so the connection is refused/reset
# at the kernel level (verified against a real kind cluster and a real
# ko-built image while writing this test: curl reports exit 56, "Recv
# failure: Connection reset by peer", http_code 000 — never a completed
# response of any kind, let alone 200). Accept curl's other well-known
# connection-failure exit codes too (7 "Couldn't connect", 52 "empty reply")
# since the exact one can vary with the host's iptables/docker-proxy setup;
# anything else (e.g. 28, a timeout — traffic silently dropped rather than
# refused/reset) is treated as a genuine failure of this test rather than
# silently accepted, since that would be a different, unverified failure
# mode.
set +e
http_code="$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${port5}/api/config" 2>/dev/null)"
curl_rc=$?
set -e
if [ "${curl_rc}" -eq 0 ]; then
  echo "FAIL: curl succeeded (http_code=${http_code}) against the published port with no HTP_K8S_ADDR set — IMAGE's own default is no longer loopback-only, the exact fail-open regression issue #127 exists to prevent." >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
case "${curl_rc}" in
7 | 52 | 56) : ;;
*)
  echo "FAIL: expected a connection-refused/reset curl exit code (7, 52, or 56), got ${curl_rc} (http_code=${http_code}) — an unrecognized failure mode, not the refused/reset this test asserts." >&2
  docker logs "${name}" >&2 || true
  exit 1
  ;;
esac
if [ "${http_code}" = "200" ]; then
  echo "FAIL: got http_code 200 from a curl call that reported failure (curl_rc=${curl_rc}) — contradictory result, treat as a test bug rather than trusting either half." >&2
  exit 1
fi
if ! container_is_running "${name}"; then
  echo "FAIL: container stopped running during the port-unreachability probe — the port being unreachable may just mean the process died mid-test, not that it correctly stayed loopback-bound." >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: IMAGE's own default (no HTP_K8S_ADDR) left the published port unreachable (curl exit ${curl_rc}) while the container stayed running and logged a genuine loopback bind — fail-closed, not crashed."

log "Test 5b: positive control — the identical invocation WITH HTP_K8S_ADDR=:8080 serves 200"
name="htpk8s-image-default-positive-control"
CONTAINERS+=("${name}")
port5b="$(pick_free_port)"
docker run -d --name "${name}" --network kind \
  --user "${HOST_USER}" \
  -p "127.0.0.1:${port5b}:8080" \
  -v "${INTERNAL_KUBECONFIG}:/kube/config:ro" \
  -e HTP_K8S_ADDR=:8080 \
  "${IMAGE}" >/dev/null

if ! wait_http_200 "${port5b}" /api/config 20; then
  echo "FAIL: positive control (same invocation as 5a, plus HTP_K8S_ADDR=:8080) did not serve GET /api/config within 20s — without this working, Test 5a's failure proves nothing (could be an unrelated networking/cluster problem, not the loopback default). Container log:" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
docker rm -f "${name}" >/dev/null 2>&1
echo "OK: the identical invocation with HTP_K8S_ADDR=:8080 set does serve 200 — Test 5a's unreachability is attributable to the loopback default, not some other break."

log "All container kubeconfig fallback checks passed."
