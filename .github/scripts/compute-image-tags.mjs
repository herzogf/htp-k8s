#!/usr/bin/env node
// Computes the set of container-image tags a release publishes (issue #64).
// Used by release.yml's `image` job, which passes the result straight to
// `ko build --tags`.
//
// Deliberately a pure, importable function (`computeTags`) with the CLI as a
// thin wrapper, rather than the inline shell this replaced — release.yml
// only ever runs on a real `v*` tag push, so PR CI can NEVER exercise it
// directly (the lesson from issue #156: a release-only path shipped broken
// because PR CI structurally could not run it). A pure module gets real
// PR-time coverage instead, via compute-image-tags.test.mjs (wired into
// build.yml's Frontend (Node) job and the root `task test`).
//
// THE RULE (decided with the maintainer, issue #64; recorded in full,
// alongside its rationale, in ADR-0005):
//
//   Stable release vX.Y.Z (no "-" in the tag):
//     - always publish the exact vX.Y.Z tag
//     - always publish X.Y, moved to the newest patch within that minor
//     - publish bare X only once X >= 1 (SemVer gives no compatibility
//       guarantee across 0.x MINORs, so a moving bare `0` would imply a
//       stability guarantee that doesn't exist; X.Y remains honest pre-1.0
//       because PATCH releases stay backward-compatible even there)
//     - publish `latest` AND bare X only when this release is the highest
//       stable version that exists (a backport patch to an older line must
//       NOT move latest backwards — the bug this fixes, see below)
//
//   Prerelease vX.Y.Z-something (tag contains "-"): the exact tag ONLY. No
//   moving tags, no latest.
//
// THE BUG THIS FIXES: the shell logic this module replaced
// (`case "$RELEASE_TAG" in *-*) ... ;; *) tags="$RELEASE_TAG,latest" ;;
// esac`) moved `latest` for ANY stable tag, unconditionally — so a backport
// patch released after a newer minor/major already shipped would repoint
// `latest` at OLDER software. Nobody had hit it because every release so far
// has been strictly linear; computeTags's "highest stable version" check
// (below) is what makes that no longer possible.
//
// Malformed input: a RELEASE_TAG that doesn't parse as vMAJOR.MINOR.PATCH
// (optionally -PRERELEASE) throws. A release should not proceed on a tag it
// cannot parse — see the "malformed input" test for the exact case. Entries
// in `existingTags` that don't parse are silently ignored instead: they are
// historical context, not the tag actually being released, so one stray
// unparsable tag elsewhere in the repo's history must not fail every future
// release.

// A deliberately narrow parser for this project's own tagging convention
// (vMAJOR.MINOR.PATCH, optionally "-PRERELEASE" with SemVer's own
// prerelease-identifier charset) — not a general SemVer parser (no build
// metadata, no leading-zero rejection beyond what MAJOR/MINOR/PATCH already
// require). Sufficient because release.yml only ever tags `v*` pushes this
// project itself created.
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function parseTag(tag) {
  const m = TAG_RE.exec(tag)
  if (!m) return null
  return {
    tag,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  }
}

// Numeric MAJOR.MINOR.PATCH comparison only — both operands are always
// already-filtered stable (non-prerelease) versions by the time this is
// called, so prerelease ordering never needs to be expressed.
function compareStable(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/**
 * Compute the ordered list of container-image tags a release should
 * publish.
 *
 * @param {string} releaseTag - the tag actually being released (e.g. from
 *   `github.ref_name`). Must parse as vMAJOR.MINOR.PATCH[-PRERELEASE];
 *   throws otherwise.
 * @param {string[]} [existingTags] - every other tag the repo already has
 *   (e.g. `git tag --list 'v*'` output, one per line). May or may not
 *   include releaseTag itself — either is handled correctly. Entries that
 *   don't parse as vMAJOR.MINOR.PATCH[-PRERELEASE] are ignored.
 * @returns {string[]} tags in publish order, e.g. ["v1.2.3", "1.2", "1",
 *   "latest"]. Never empty — always at least the exact tag.
 */
export function computeTags(releaseTag, existingTags = []) {
  const release = parseTag(releaseTag)
  if (!release) {
    throw new Error(
      `computeTags: "${releaseTag}" is not a recognized vMAJOR.MINOR.PATCH[-PRERELEASE] tag`,
    )
  }

  if (release.prerelease !== null) {
    // Prereleases are pinned artifacts by design: exact tag only, never a
    // moving tag, never `latest` (issue #64).
    return [release.tag]
  }

  // Every OTHER already-known STABLE tag, parsed. Prerelease tags and
  // unparsable entries are irrelevant here and dropped; `release` itself is
  // excluded here and re-added below so it's counted exactly once
  // regardless of whether the caller's `existingTags` already contains it
  // (real callers will: the tag is pushed, and thus exists, before this
  // workflow runs).
  const otherStable = existingTags
    .map(parseTag)
    .filter((t) => t !== null && t.prerelease === null && t.tag !== release.tag)

  const allStable = [release, ...otherStable]

  const isHighestOverall = allStable.every((t) => compareStable(release, t) >= 0)
  const isHighestInMinor = allStable
    .filter((t) => t.major === release.major && t.minor === release.minor)
    .every((t) => compareStable(release, t) >= 0)

  const tags = [release.tag]
  if (isHighestInMinor) tags.push(`${release.major}.${release.minor}`)
  if (release.major >= 1 && isHighestOverall) tags.push(`${release.major}`)
  if (isHighestOverall) tags.push('latest')
  return tags
}

// ---------------------------------------------------------------------------
// CLI: `git tag --list 'v*' | node compute-image-tags.mjs <release-tag>`
// Prints the computed tags, comma-joined (ko's `--tags` format), to stdout.
// Only runs when this file is executed directly, not when imported by the
// test suite.
// ---------------------------------------------------------------------------

async function readStdinTags() {
  // No pipe attached (e.g. run interactively with no `git tag |`): treat as
  // "no existing tags" rather than hanging on stdin.
  if (process.stdin.isTTY) return []
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

async function main() {
  const releaseTag = process.argv[2]
  if (!releaseTag) {
    console.error('usage: git tag --list "v*" | node compute-image-tags.mjs <release-tag>')
    process.exitCode = 2
    return
  }
  const existingTags = await readStdinTags()
  const tags = computeTags(releaseTag, existingTags)
  console.log(tags.join(','))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
