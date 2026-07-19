# Shared guarded lifecycle for test/e2e/capture's runtime-only `node_modules`
# symlink onto web/node_modules (issue #130).
#
# Both `run.sh` (the `record` Task, via capture.mjs's @playwright/test import)
# and Taskfile.yml's `test` task (via node_modules/.bin/vitest) point this
# same symlink at web/node_modules, for the reason documented in run.sh's
# header comment: Node's ESM resolver looks for node_modules starting at the
# *importing file's own directory* and walking up, which never reaches
# web/node_modules from test/e2e/capture on its own, and this directory has
# no package.json/node_modules of its own to avoid drifting from the pinned
# Chromium build web/e2e's Playwright suite uses.
#
# Before issue #130, each caller hand-rolled its own guard logic, and had
# drifted: run.sh created AND removed the symlink with a "some real thing
# already exists at this path" guard, while the Task's `test` task created it
# with no guard at all and never removed it. Sourcing this one file into both
# keeps their guard/create/remove logic identical by construction rather than
# by two callers staying in sync by hand.
#
# This does NOT make the two callers safe to run concurrently against each
# other — they still share one path, by necessity: Node's module resolution
# algorithm only ever looks for a directory literally named `node_modules`,
# so the two callers can't be given distinct symlink names while both still
# work. What this DOES guarantee is that neither caller ever corrupts or
# silently no-ops on a path already occupied by something unexpected, and
# that both clean up after themselves the same way. Running `task
# capture:record` and `task capture:test` concurrently remains unsupported.
#
# Usage (source into a caller that has already set its own `set -euo
# pipefail` or equivalent — this file defines functions only, and doesn't set
# shell options itself):
#   source ".../lib/node-modules-symlink.sh"
#   check_capture_node_modules_prereqs "<link_path>" "<web_node_modules_dir>"
#   ...
#   create_capture_node_modules_symlink "<link_path>" "<web_node_modules_dir>"
#   ...
#   remove_capture_node_modules_symlink "<link_path>"

# check_capture_node_modules_prereqs: validation only, no filesystem changes.
# Meant to run BEFORE any expensive work a caller does next (run.sh's build +
# cluster-create), so a missing prerequisite or a foreign occupant of the
# link path fails fast and legibly instead of opaquely mid-run.
#
#   - web/node_modules must exist for the symlink trick to work at all.
#   - the link path must not already exist as something other than a symlink
#     this tool manages — `ln -sfn` silently nests the new symlink INSIDE a
#     pre-existing real directory of that name instead of erroring, which
#     would both fail to expose the intended package and leave
#     remove_capture_node_modules_symlink's `[ -L ... ]` guard unable to
#     recognise (and thus not clean up) the mess.
check_capture_node_modules_prereqs() {
  local link="$1"
  local web_node_modules="$2"

  if [ ! -d "${web_node_modules}" ]; then
    echo "ERROR: ${web_node_modules} not found — run 'npm ci' in web/ (or 'task web:install') first." >&2
    return 1
  fi
  if [ -e "${link}" ] && [ ! -L "${link}" ]; then
    echo "ERROR: ${link} exists and is not a symlink this tool manages — remove it manually and re-run." >&2
    return 1
  fi
  return 0
}

# create_capture_node_modules_symlink: re-checks the same prerequisites (the
# world can change between an early fail-fast check and actual use — e.g. a
# concurrent run, however unsupported, leaving something unexpected at the
# link path) and then creates the symlink. Idempotent (`ln -sfn` on a symlink
# this tool already manages just re-points it at the same target).
create_capture_node_modules_symlink() {
  local link="$1"
  local web_node_modules="$2"

  check_capture_node_modules_prereqs "${link}" "${web_node_modules}"
  ln -sfn "$(cd "${web_node_modules}" && pwd)" "${link}"
}

# remove_capture_node_modules_symlink: idempotent, and only ever removes
# something WE created (a symlink at this exact path) — never a real
# directory, even one accidentally left at this path by something else.
remove_capture_node_modules_symlink() {
  local link="$1"
  if [ -L "${link}" ]; then
    rm -f "${link}"
  fi
}
