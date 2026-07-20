// Permanent regression suite for computeTags (issue #64) — this is the code
// that actually decides which container-image tags a stable release moves,
// so a bug here silently ships a wrong `latest`/`X`/`X.Y` with no other
// signal (release.yml itself never runs in PR CI to catch it — see
// compute-image-tags.mjs's header comment). Uses Node's own built-in test
// runner (`node:test`/`node:assert`) — this module has zero dependencies of
// its own, so unlike the capture harness's Vitest suite (test/e2e/capture),
// it needs no web/node_modules symlink to run.
//
// Run directly: `node --test .github/scripts`
// Wired into CI via: build.yml's Frontend (Node) job (its own named step)
// AND the root Taskfile's aggregate `test:` task (so `task test` locally,
// and the Backend (Go) job's `task test` step in CI, exercise it too).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeTags } from './compute-image-tags.mjs'

describe('computeTags', () => {
  it('prerelease: exact tag only, no matter what else exists', () => {
    assert.deepEqual(computeTags('v1.0.0-rc.1', ['v0.9.9']), ['v1.0.0-rc.1'])
  })

  it('prerelease with a hyphenated identifier: still exact-only', () => {
    assert.deepEqual(computeTags('v2.1.0-beta.3'), ['v2.1.0-beta.3'])
  })

  it('stable + highest overall (0.x): exact, minor, latest — no bare 0', () => {
    assert.deepEqual(computeTags('v0.3.1', []), ['v0.3.1', '0.3', 'latest'])
  })

  it('stable + highest overall, another 0.x already exists: bare 0 still never appears', () => {
    assert.deepEqual(computeTags('v0.9.9', ['v0.9.8', 'v0.8.0']), ['v0.9.9', '0.9', 'latest'])
  })

  it('the 0.9.9 -> 1.0.0 boundary: bare major appears exactly at 1.0.0, not before', () => {
    assert.deepEqual(computeTags('v0.9.9', ['v1.0.0']), ['v0.9.9', '0.9'])
    assert.deepEqual(computeTags('v1.0.0', ['v0.9.9']), ['v1.0.0', '1.0', '1', 'latest'])
  })

  it('stable + highest overall (1.x): exact, minor, major, latest', () => {
    assert.deepEqual(computeTags('v1.4.0', ['v1.3.9', 'v0.9.0']), [
      'v1.4.0',
      '1.4',
      '1',
      'latest',
    ])
  })

  it('stable, NOT highest overall (backport patch to an older minor): moves its own X.Y, never latest/major', () => {
    // v0.3.2 cut after v0.4.0 already exists.
    assert.deepEqual(computeTags('v0.3.2', ['v0.4.0']), ['v0.3.2', '0.3'])
  })

  it('stable, NOT highest overall, major already >= 1: still no bare major, no latest', () => {
    // v1.2.4 cut after v1.3.0 already exists.
    assert.deepEqual(computeTags('v1.2.4', ['v1.3.0', 'v1.2.3']), ['v1.2.4', '1.2'])
  })

  it('first-ever release: no existing tags at all is trivially "highest"', () => {
    assert.deepEqual(computeTags('v0.1.0', []), ['v0.1.0', '0.1', 'latest'])
  })

  it('first-ever release straight to 1.0.0: gets the bare major too', () => {
    assert.deepEqual(computeTags('v1.0.0', []), ['v1.0.0', '1.0', '1', 'latest'])
  })

  it('does not double-count when existingTags already includes the release tag itself', () => {
    // git tag --list already includes the just-pushed tag by the time this
    // job runs — the function must not treat that as "a higher tag exists".
    assert.deepEqual(computeTags('v0.3.1', ['v0.3.1', 'v0.3.0']), ['v0.3.1', '0.3', 'latest'])
  })

  it('ignores prerelease and unparsable entries in existingTags', () => {
    assert.deepEqual(computeTags('v0.3.1', ['v0.4.0-rc.1', 'not-a-tag', 'v0']), [
      'v0.3.1',
      '0.3',
      'latest',
    ])
  })

  it('out-of-order patch release within a minor: X.Y does not move backwards either', () => {
    // v1.2.3 released AFTER v1.2.4 already exists (e.g. re-tagging an old
    // commit) must not repoint 1.2 back to the older patch.
    assert.deepEqual(computeTags('v1.2.3', ['v1.2.4']), ['v1.2.3'])
  })

  it('malformed release tag: throws rather than silently proceeding', () => {
    assert.throws(() => computeTags('not-a-tag', []), /not a recognized/)
    assert.throws(() => computeTags('1.2.3', []), /not a recognized/) // missing leading "v"
    assert.throws(() => computeTags('v1.2', []), /not a recognized/) // missing patch
    assert.throws(() => computeTags('v1.2.3.4', []), /not a recognized/)
    assert.throws(() => computeTags('', []), /not a recognized/)
  })
})
