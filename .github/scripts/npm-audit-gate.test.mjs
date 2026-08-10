// Permanent regression suite for the npm-audit-gate (issue #189) — the
// time-boxed allowlist that stands between an unfixable-but-flagged npm
// advisory and every PR going red indefinitely (see the module header in
// npm-audit-gate.mjs for the full rationale). Node's own built-in test
// runner, matching compute-image-tags.test.mjs's own convention (this
// module has zero dependencies of its own, so no web/node_modules symlink
// is needed to run it).
//
// Run directly: `node --test .github/scripts/npm-audit-gate.test.mjs`
// (the explicit file, not a glob — see compute-image-tags.test.mjs's own
// comment for why a glob is the wrong call here).
// Wired into CI via build.yml's Frontend (Node) job, mirroring the existing
// "Release image-tag computation tests" step.
//
// The guiding constraint under test throughout: FAIL CLOSED. Every
// malformed-input case below asserts a thrown error, never a silent pass.
//
// Two layers are covered, deliberately (PR #193 review round 1 — the
// original version of this suite covered only the pure functions, and the
// reported fail-open bug lived in the CLI layer that was untested):
//   1. The pure core: extractAdvisories, parseAllowlist, evaluateGate,
//      formatReport — no I/O, no clock dependency (Date injected).
//   2. The CLI layer: parseArgs, runNpmAudit, readAllowlist, run() —
//      exercised via dependency injection (fake spawn/readFile functions,
//      no real npm or filesystem touched).
//
// Round 2 removed the ESM entry-point guard entirely rather than hardening
// it further (see npm-audit-gate.mjs's header) — npm-audit-gate.mjs is now
// import-only with no side effect, and npm-audit-gate-cli.mjs is the real,
// unguarded entry point. The "does invoking it through a symlink / a spaced
// path actually run and produce real output" question that round 1's guard
// tests answered now applies to THAT file instead — see "the real CLI
// process" describe block near the end of this suite, which spawns the
// actual `npm-audit-gate-cli.mjs` (not a guard-only fixture) as a real
// child `node` process through several invocation forms, exactly the
// reproduction that caught the original bug.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  evaluateGate,
  extractAdvisories,
  formatReport,
  MAX_WAIVER_HORIZON_DAYS,
  parseAllowlist,
  parseArgs,
  readAllowlist,
  run,
  runNpmAudit,
} from './npm-audit-gate.mjs'

const TODAY = new Date('2026-08-10T12:00:00Z')
const CLI_SCRIPT_PATH = fileURLToPath(new URL('./npm-audit-gate-cli.mjs', import.meta.url))
const LIB_SCRIPT_PATH = fileURLToPath(new URL('./npm-audit-gate.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// A real `npm audit --json` shape (auditReportVersion 2, npm 11.x),
// captured against a scratch project seeded with a known-vulnerable
// `minimist@0.0.8` — see the PR description for the verbatim command.
function auditWithFindings(...advisoryUrls) {
  const via = advisoryUrls.map((url, i) => ({
    source: 1000000 + i,
    name: 'somepkg',
    dependency: 'somepkg',
    title: `Some vulnerability ${i}`,
    url,
    severity: 'high',
    cwe: ['CWE-1321'],
    cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
    range: '<1.2.3',
  }))
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      somepkg: {
        name: 'somepkg',
        severity: 'high',
        isDirect: false,
        via,
        effects: [],
        range: '<1.2.3',
        nodes: ['node_modules/somepkg'],
        fixAvailable: false,
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  }
}

const CLEAN_AUDIT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
}

const EMPTY_ALLOWLIST = JSON.stringify({ waivers: [] })

function waiverList(...waivers) {
  return JSON.stringify({ waivers })
}

describe('extractAdvisories', () => {
  it('a clean report has no advisories', () => {
    assert.deepEqual([...extractAdvisories(CLEAN_AUDIT).keys()], [])
  })

  it('extracts the GHSA id out of the advisory url', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-vh95-rmgr-6w4m'))
    assert.deepEqual([...advisories.keys()], ['GHSA-VH95-RMGR-6W4M'])
    const found = advisories.get('GHSA-VH95-RMGR-6W4M')
    assert.equal(found.severity, 'high')
    assert.ok(found.packages.has('somepkg'))
  })

  it('deduplicates the same GHSA id reported via multiple packages', () => {
    const audit = {
      auditReportVersion: 2,
      vulnerabilities: {
        a: {
          name: 'a',
          severity: 'high',
          via: [{ source: 1, name: 'a', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
        b: {
          name: 'b',
          severity: 'high',
          via: [{ source: 1, name: 'a', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 2 } },
    }
    const advisories = extractAdvisories(audit)
    assert.equal(advisories.size, 1)
    assert.deepEqual([...advisories.get('GHSA-AAAA-BBBB-CCCC').packages].sort(), ['a', 'b'])
  })

  it('skips a string `via` entry that resolves to a real vulnerability entry', () => {
    const audit = {
      auditReportVersion: 2,
      vulnerabilities: {
        top: { name: 'top', severity: 'high', via: ['somepkg'] },
        somepkg: {
          name: 'somepkg',
          severity: 'high',
          via: [{ source: 1, name: 'somepkg', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 2 } },
    }
    const advisories = extractAdvisories(audit)
    assert.deepEqual([...advisories.keys()], ['GHSA-AAAA-BBBB-CCCC'])
  })

  it('throws on a string `via` entry that references a package NOT in the report (dangling/malformed chain)', () => {
    // PR #193 review: silently `continue`-ing on every string `via`
    // without checking the reference resolves would let a report whose
    // `via` chains are entirely such dangling strings extract ZERO
    // advisories and gate green despite reporting findings.
    const audit = {
      vulnerabilities: {
        top: { name: 'top', severity: 'high', via: ['nonexistent-package'] },
      },
      metadata: { vulnerabilities: { total: 1 } },
    }
    assert.throws(() => extractAdvisories(audit), /references "nonexistent-package", which is not itself a reported vulnerability/)
  })

  it('throws when every "via" is a closed loop of valid-looking string references with no terminal advisory object (reachability invariant)', () => {
    // Both string references here DO resolve to real vulnerabilities-map
    // keys (so the dangling-reference check above does not fire), but
    // neither entry ever carries a real advisory object, directly or
    // transitively — a and b resolve only to each other, forever. Exactly
    // the round-1 "belt-and-suspenders" cross-check's blind spot (PR #193
    // review round 2): this audit has NO metadata at all, so the old
    // `reportedTotal > 0` check never even ran, yet extraction still
    // yields zero advisories. The reachability invariant catches it
    // independent of metadata.
    const audit = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: ['b'] },
        b: { name: 'b', severity: 'high', via: ['a'] },
      },
    }
    assert.throws(() => extractAdvisories(audit), /"a" resolves to no real advisory, directly or transitively/)
  })

  it('throws when SOME packages resolve fine and others are a closed loop (partial-extraction blind spot, PR #193 review round 2)', () => {
    // The reviewer's second crafted proof: round 1's check only fired when
    // `advisories.size === 0` OVERALL, so a report where "c" resolves fine
    // while "a"/"b" loop forever slipped through — `metadata.total: 3`
    // even nominally "matches" the package count, so neither round-1 check
    // would have caught this. The reachability invariant checks EVERY
    // package individually, so it still throws for "a" (and "b").
    const audit = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: ['b'] },
        b: { name: 'b', severity: 'high', via: ['a'] },
        c: {
          name: 'c',
          severity: 'high',
          via: [{ source: 1, name: 'c', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 3 } },
    }
    assert.throws(() => extractAdvisories(audit), /"a" resolves to no real advisory, directly or transitively/)
  })

  // PR #193 review round 3: a genuinely resolvable member of a cycle must
  // pass REGARDLESS of `via` array order. The earlier (round 2) DFS-with-
  // memoization implementation returned the right answer for one order and
  // the WRONG answer (an unpassable throw — no allowlist entry can waive
  // an extractAdvisories throw, since it runs before evaluateGate ever
  // sees an allowlist) for the other, on this EXACT shape: X and Y form a
  // cycle, but X *also* has an edge straight to Z, which carries a real
  // advisory. Reproduced for real against a 171-package `npm audit --json`
  // report (gulp@3.9.1 + react-scripts@1.1.5) containing a genuine
  // babel-core <-> babel-register cycle — it passed only because of which
  // `via` entry happened to be visited first; reordering it flipped PASS
  // to an unpassable THROW on otherwise-identical input. These two cases
  // pin both orders explicitly; the property test below generalizes it.
  it('a cycle member that ALSO has a direct edge to a real advisory resolves — via order ["Y", "Z"]', () => {
    const audit = {
      vulnerabilities: {
        X: { name: 'X', severity: 'high', via: ['Y', 'Z'] },
        Y: { name: 'Y', severity: 'high', via: ['X'] },
        Z: {
          name: 'Z',
          severity: 'high',
          via: [{ source: 1, name: 'Z', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 3 } },
    }
    const advisories = extractAdvisories(audit)
    assert.deepEqual([...advisories.keys()], ['GHSA-AAAA-BBBB-CCCC'])
  })

  it('a cycle member that ALSO has a direct edge to a real advisory resolves — via order ["Z", "Y"] (order-flip regression)', () => {
    const audit = {
      vulnerabilities: {
        X: { name: 'X', severity: 'high', via: ['Z', 'Y'] },
        Y: { name: 'Y', severity: 'high', via: ['X'] },
        Z: {
          name: 'Z',
          severity: 'high',
          via: [{ source: 1, name: 'Z', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 3 } },
    }
    const advisories = extractAdvisories(audit)
    assert.deepEqual([...advisories.keys()], ['GHSA-AAAA-BBBB-CCCC'])
  })

  it('order-independence property: every permutation of a fixed graph\'s "via" arrays yields the same resolvability', () => {
    // A property that only holds for one arbitrary ordering isn't the
    // property this invariant needs — assert it holds for every
    // permutation of a small fixed graph rather than just the two orders
    // pinned explicitly above. X and Y cycle; X and W both also point
    // straight at Z (the one real advisory); the SET of resolvable
    // packages must always be {X, Y, W, Z} no matter which order any
    // package's own "via" array lists its edges in.
    function permutations(arr) {
      if (arr.length <= 1) return [arr]
      const result = []
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
        for (const p of permutations(rest)) result.push([arr[i], ...p])
      }
      return result
    }

    const zAdvisory = {
      source: 1,
      name: 'Z',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      severity: 'high',
      title: 't',
    }

    for (const xOrder of permutations(['Y', 'Z'])) {
      for (const wOrder of permutations(['Z'])) {
        const audit = {
          vulnerabilities: {
            X: { name: 'X', severity: 'high', via: xOrder },
            Y: { name: 'Y', severity: 'high', via: ['X'] },
            W: { name: 'W', severity: 'high', via: wOrder },
            Z: { name: 'Z', severity: 'high', via: [zAdvisory] },
          },
          metadata: { vulnerabilities: { total: 4 } },
        }
        const advisories = extractAdvisories(audit)
        assert.deepEqual(
          [...advisories.keys()],
          ['GHSA-AAAA-BBBB-CCCC'],
          `via order X=${JSON.stringify(xOrder)} W=${JSON.stringify(wOrder)} should still resolve every package`,
        )
      }
    }
  })

  it('resolves a pathologically deep "via" chain without a stack overflow (the reachability check is iterative, not recursive)', () => {
    // A side benefit of the round-3 BFS-from-resolved-set rewrite: a
    // recursive DFS on a chain this deep would blow the call stack
    // (RangeError: Maximum call stack size exceeded) well before this size
    // — this walks a queue instead, so depth is bounded only by available
    // memory, not stack frames.
    const DEPTH = 20_000
    const vulnerabilities = {}
    for (let i = 0; i < DEPTH; i++) {
      vulnerabilities[`pkg${i}`] = {
        name: `pkg${i}`,
        severity: 'high',
        via:
          i === DEPTH - 1
            ? [{ source: 1, name: `pkg${i}`, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }]
            : [`pkg${i + 1}`],
      }
    }
    const audit = { vulnerabilities, metadata: { vulnerabilities: { total: DEPTH } } }
    const advisories = extractAdvisories(audit)
    assert.deepEqual([...advisories.keys()], ['GHSA-AAAA-BBBB-CCCC'])
  })

  it('throws when "metadata.vulnerabilities.total" is missing, even on an otherwise well-formed, fully-resolvable report', () => {
    const audit = {
      vulnerabilities: {
        somepkg: {
          name: 'somepkg',
          via: [{ source: 1, name: 'somepkg', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      // no `metadata` at all
    }
    assert.throws(() => extractAdvisories(audit), /"metadata.vulnerabilities.total" is missing or not a number/)
  })

  it('throws when "metadata.vulnerabilities.total" is a STRING rather than a number (PR #193 review round 2)', () => {
    // The reviewer's third crafted variant: `total: "2"` (matching the
    // package count as a STRING) must still fail — mandatory means
    // type-checked, not just "present and falsy-or-not".
    const audit = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: [{ source: 1, name: 'a', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }] },
        b: { name: 'b', severity: 'high', via: [{ source: 2, name: 'b', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'high', title: 't' }] },
      },
      metadata: { vulnerabilities: { total: '2' } },
    }
    assert.throws(() => extractAdvisories(audit), /"metadata.vulnerabilities.total" is missing or not a number/)
  })

  it('throws when "metadata.vulnerabilities.total" is numeric but does not match the package count', () => {
    const audit = {
      vulnerabilities: {
        somepkg: {
          name: 'somepkg',
          via: [{ source: 1, name: 'somepkg', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }],
        },
      },
      metadata: { vulnerabilities: { total: 5 } },
    }
    assert.throws(() => extractAdvisories(audit), /metadata reports 5 vulnerable package\(s\) but "vulnerabilities" lists 1/)
  })

  it('throws on npm audit\'s own error shape rather than treating it as clean', () => {
    const auditError = { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }
    assert.throws(() => extractAdvisories(auditError), /npm audit reported an error/)
  })

  it('throws when "vulnerabilities" is missing entirely', () => {
    assert.throws(() => extractAdvisories({ auditReportVersion: 2 }), /missing or malformed "vulnerabilities"/)
  })

  it('throws when "vulnerabilities" is the wrong type', () => {
    assert.throws(() => extractAdvisories({ vulnerabilities: 'nope' }), /missing or malformed "vulnerabilities"/)
    assert.throws(() => extractAdvisories({ vulnerabilities: [] }), /missing or malformed "vulnerabilities"/)
  })

  it('throws when input is not an object at all', () => {
    assert.throws(() => extractAdvisories(null), /missing or malformed/)
    assert.throws(() => extractAdvisories('not json'), /missing or malformed/)
  })

  it('throws when a vulnerability entry has no "via" array', () => {
    assert.throws(
      () => extractAdvisories({ vulnerabilities: { somepkg: { name: 'somepkg' } } }),
      /has no non-empty "via" array/,
    )
  })

  it('throws when a vulnerability entry has an EMPTY "via" array', () => {
    assert.throws(
      () => extractAdvisories({ vulnerabilities: { somepkg: { name: 'somepkg', via: [] } } }),
      /has no non-empty "via" array/,
    )
  })

  it('throws when an advisory has no extractable GHSA id', () => {
    const audit = {
      vulnerabilities: {
        somepkg: {
          name: 'somepkg',
          via: [{ source: 1, name: 'somepkg', title: 't', severity: 'high' /* no url */ }],
        },
      },
    }
    assert.throws(() => extractAdvisories(audit), /no extractable GHSA id/)
  })

  it('throws on a non-GHSA advisory url (documented limitation, not a silent pass)', () => {
    const audit = {
      vulnerabilities: {
        somepkg: {
          name: 'somepkg',
          via: [{ source: 1, name: 'somepkg', title: 't', severity: 'high', url: 'https://npmjs.com/advisories/1234' }],
        },
      },
    }
    assert.throws(() => extractAdvisories(audit), /no extractable GHSA id/)
  })
})

describe('parseAllowlist', () => {
  it('an empty waivers array parses to no waivers', () => {
    assert.deepEqual(parseAllowlist(EMPTY_ALLOWLIST, TODAY), [])
  })

  it('parses a well-formed waiver and normalizes the id to uppercase', () => {
    const waivers = parseAllowlist(
      waiverList({
        id: 'ghsa-aaaa-bbbb-cccc',
        expires: '2026-09-01',
        reason: 'no upstream fix; dev-only tooling',
        issue: '#999',
      }),
      TODAY,
    )
    assert.deepEqual(waivers, [
      { id: 'GHSA-AAAA-BBBB-CCCC', expires: '2026-09-01', reason: 'no upstream fix; dev-only tooling', issue: '#999' },
    ])
  })

  it('accepts a full GitHub issue URL for "issue"', () => {
    const waivers = parseAllowlist(
      waiverList({
        id: 'GHSA-aaaa-bbbb-cccc',
        expires: '2026-09-01',
        reason: 'reason',
        issue: 'https://github.com/herzogf/htp-k8s/issues/999',
      }),
      TODAY,
    )
    assert.equal(waivers[0].issue, 'https://github.com/herzogf/htp-k8s/issues/999')
  })

  it('defaults "today" to the real clock when not supplied (wiring smoke test)', () => {
    // Whatever "now" really is, a waiver 1 day out is always within the cap
    // and never expired-at-parse-time (expiry itself is evaluateGate's job,
    // not parseAllowlist's) — this only pins that the default parameter
    // wires to a real Date, not that it throws.
    const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const waivers = parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: soon, reason: 'r', issue: '#1' }))
    assert.equal(waivers[0].expires, soon)
  })

  it('throws on invalid top-level JSON', () => {
    assert.throws(() => parseAllowlist('{not json', TODAY), /invalid JSON/)
  })

  it('throws when top level is not an object shaped { waivers: [...] }', () => {
    assert.throws(() => parseAllowlist('[]', TODAY), /top level must be an object/)
    assert.throws(() => parseAllowlist('null', TODAY), /top level must be an object/)
    assert.throws(() => parseAllowlist(JSON.stringify({ waivers: 'nope' }), TODAY), /"waivers" must be an array/)
  })

  it('throws when a waiver is missing "id"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ expires: '2026-09-01', reason: 'r', issue: '#1' }), TODAY),
      /missing required string field "id"/,
    )
  })

  it('throws on a malformed GHSA id', () => {
    assert.throws(
      () =>
        parseAllowlist(waiverList({ id: 'not-a-ghsa-id', expires: '2026-09-01', reason: 'r', issue: '#1' }), TODAY),
      /not a well-formed GHSA advisory id/,
    )
  })

  it('throws when a waiver is missing "expires"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', reason: 'r', issue: '#1' }), TODAY),
      /missing required string field "expires"/,
    )
  })

  it('throws on a malformed expires date (bad format)', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '09/01/2026', reason: 'r', issue: '#1' }),
          TODAY,
        ),
      /not a valid ISO YYYY-MM-DD/,
    )
  })

  it('throws on a calendar-invalid expires date (e.g. Feb 30)', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-02-30', reason: 'r', issue: '#1' }),
          TODAY,
        ),
      /not a valid ISO YYYY-MM-DD/,
    )
  })

  it('accepts a waiver exactly at the MAX_WAIVER_HORIZON_DAYS cap', () => {
    const atCap = new Date(Date.UTC(2026, 7, 10) + MAX_WAIVER_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10)
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: atCap, reason: 'r', issue: '#1' }),
      TODAY,
    )
    assert.equal(waivers[0].expires, atCap)
  })

  it('rejects a waiver ONE day past the MAX_WAIVER_HORIZON_DAYS cap', () => {
    // Pins the exact bug the review flagged: `expires: "2099-01-01"` must
    // NOT validate — "time-boxed" is structural, not honor-system.
    const pastCap = new Date(Date.UTC(2026, 7, 10) + (MAX_WAIVER_HORIZON_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: pastCap, reason: 'r', issue: '#1' }), TODAY),
      new RegExp(`past the ${MAX_WAIVER_HORIZON_DAYS}-day cap`),
    )
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2099-01-01', reason: 'r', issue: '#1' }), TODAY),
      new RegExp(`past the ${MAX_WAIVER_HORIZON_DAYS}-day cap`),
    )
  })

  it('throws when a waiver is missing "reason"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', issue: '#1' }), TODAY),
      /missing required non-empty string field "reason"/,
    )
  })

  it('throws when "reason" is blank', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: '   ', issue: '#1' }),
          TODAY,
        ),
      /missing required non-empty string field "reason"/,
    )
  })

  it('throws when a waiver is missing "issue"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r' }), TODAY),
      /missing required string field "issue"/,
    )
  })

  it('throws when "issue" is not a recognizable tracking-issue reference', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: 'see slack' }),
          TODAY,
        ),
      /must be a tracking issue reference/,
    )
  })

  it('throws on duplicate waivers for the same advisory', () => {
    const entry = { id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: '#1' }
    assert.throws(
      () => parseAllowlist(waiverList(entry, { ...entry, expires: '2026-10-01' }), TODAY),
      /duplicate waiver/,
    )
  })

  it('throws when a waiver entry itself is not an object', () => {
    assert.throws(() => parseAllowlist(JSON.stringify({ waivers: ['GHSA-aaaa-bbbb-cccc'] }), TODAY), /must be an object/)
  })
})

describe('evaluateGate (two-state + expiry behaviour)', () => {
  it('clean audit + empty allowlist: passes', () => {
    const result = evaluateGate(extractAdvisories(CLEAN_AUDIT), parseAllowlist(EMPTY_ALLOWLIST, TODAY), TODAY)
    assert.equal(result.ok, true)
    assert.deepEqual(result.unwaivedFindings, [])
    assert.deepEqual(result.expiredWaivers, [])
  })

  it('unwaived advisory: fails', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const result = evaluateGate(advisories, parseAllowlist(EMPTY_ALLOWLIST, TODAY), TODAY)
    assert.equal(result.ok, false)
    assert.equal(result.unwaivedFindings.length, 1)
    assert.equal(result.unwaivedFindings[0].id, 'GHSA-AAAA-BBBB-CCCC')
  })

  it('a validly (non-expired) waived advisory: passes', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'no fix upstream yet', issue: '#500' }),
      TODAY,
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, true)
    assert.equal(result.activeWaivers.length, 1)
  })

  it('a waiver expiring exactly today is still valid (inclusive last day)', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-08-10', reason: 'r', issue: '#500' }),
      TODAY,
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, true)
  })

  it('EXPIRED waiver (advisory still reported): fails', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-08-09', reason: 'r', issue: '#500' }),
      TODAY,
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, false)
    assert.equal(result.expiredWaivers.length, 1)
    assert.equal(result.expiredWaivers[0].waiver.id, 'GHSA-AAAA-BBBB-CCCC')
    assert.ok(result.expiredWaivers[0].advisory, 'advisory should still be attached — it is still reported')
  })

  it('EXPIRED waiver whose advisory is GONE from the report: still fails', () => {
    // The whole point of the "even if the advisory is no longer reported"
    // rule (issue #189): a stale waiver is itself a finding, not a free pass.
    const result = evaluateGate(
      extractAdvisories(CLEAN_AUDIT),
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-01-01', reason: 'r', issue: '#500' }), TODAY),
      TODAY,
    )
    assert.equal(result.ok, false)
    assert.equal(result.expiredWaivers.length, 1)
    assert.equal(result.expiredWaivers[0].advisory, null)
  })

  it('a NON-expired waiver whose advisory is gone is harmless (not yet due for cleanup)', () => {
    const result = evaluateGate(
      extractAdvisories(CLEAN_AUDIT),
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-12-31', reason: 'r', issue: '#500' }), TODAY),
      TODAY,
    )
    assert.equal(result.ok, true)
  })

  it('one waived + one unwaived advisory: overall fail, correctly split', () => {
    const advisories = extractAdvisories(
      auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'),
    )
    advisories.set('GHSA-DDDD-EEEE-FFFF', { id: 'GHSA-DDDD-EEEE-FFFF', severity: 'high', title: 't', packages: new Set(['other']) })
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: '#500' }),
      TODAY,
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, false)
    assert.equal(result.activeWaivers.length, 1)
    assert.equal(result.unwaivedFindings.length, 1)
    assert.equal(result.unwaivedFindings[0].id, 'GHSA-DDDD-EEEE-FFFF')
  })
})

describe('formatReport', () => {
  it('produces a human-readable PASS summary with no findings', () => {
    const result = evaluateGate(extractAdvisories(CLEAN_AUDIT), parseAllowlist(EMPTY_ALLOWLIST, TODAY), TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /npm-audit-gate: PASS/)
  })

  it('produces a human-readable FAIL summary naming the unwaived advisory', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const result = evaluateGate(advisories, parseAllowlist(EMPTY_ALLOWLIST, TODAY), TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /npm-audit-gate: FAIL/)
    assert.match(report, /GHSA-AAAA-BBBB-CCCC/)
  })

  it('produces a human-readable summary naming an expired waiver and its tracking issue', () => {
    const result = evaluateGate(
      extractAdvisories(CLEAN_AUDIT),
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-01-01', reason: 'r', issue: '#500' }), TODAY),
      TODAY,
    )
    const report = formatReport(result, TODAY)
    assert.match(report, /expired waivers/)
    assert.match(report, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(report, /#500/)
  })

  it('lists an active waiver with its expiry and reason', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'no fix yet', issue: '#500' }),
      TODAY,
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /Waived/)
    assert.match(report, /no fix yet/)
    assert.match(report, /2026-09-01/)
  })
})

// ---------------------------------------------------------------------------
// CLI layer (PR #193 review — the fail-open bug lived here, untested)
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults cwd to process.cwd() and allowlist to <cwd>/audit-allowlist.json', () => {
    const args = parseArgs([])
    assert.equal(args.cwd, process.cwd())
    assert.equal(args.allowlist, path.join(process.cwd(), 'audit-allowlist.json'))
  })

  it('accepts --cwd and --allowlist overrides', () => {
    const args = parseArgs(['--cwd', '/tmp/foo', '--allowlist', '/tmp/bar/list.json'])
    assert.equal(args.cwd, '/tmp/foo')
    assert.equal(args.allowlist, '/tmp/bar/list.json')
  })

  it('rejects an unrecognized argument rather than silently ignoring it', () => {
    assert.throws(() => parseArgs(['--bogus']), /unrecognized argument: --bogus/)
  })

  it('a dangling --cwd with no value fails rather than silently defaulting to something wrong', () => {
    // args.cwd becomes undefined, and computing the default allowlist path
    // (path.join(undefined, ...)) throws a TypeError — confirmed-good
    // behaviour per the PR #193 review (fails, does not silently pass).
    assert.throws(() => parseArgs(['--cwd']))
  })
})

describe('runNpmAudit (injectable spawn — no real npm process)', () => {
  it('returns the parsed JSON on a normal run (findings present, non-zero exit)', () => {
    const fakeSpawn = () => ({
      stdout: JSON.stringify(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')),
      stderr: '',
      status: 1,
      error: null,
    })
    const parsed = runNpmAudit('/some/cwd', fakeSpawn)
    assert.equal(parsed.vulnerabilities.somepkg.name, 'somepkg')
  })

  it('throws when npm cannot be spawned at all (e.g. ENOENT / killed)', () => {
    const fakeSpawn = () => ({ stdout: '', stderr: '', status: null, error: new Error('spawn npm ENOENT') })
    assert.throws(() => runNpmAudit('/some/cwd', fakeSpawn), /failed to run "npm audit --json"/)
  })

  it('throws when npm produces no stdout', () => {
    const fakeSpawn = () => ({ stdout: '', stderr: 'some fatal npm error', status: 1, error: null })
    assert.throws(() => runNpmAudit('/some/cwd', fakeSpawn), /produced no stdout/)
  })

  it('throws when npm produces stdout that is not valid JSON', () => {
    const fakeSpawn = () => ({ stdout: 'not json at all', stderr: '', status: 0, error: null })
    assert.throws(() => runNpmAudit('/some/cwd', fakeSpawn), /produced unparseable JSON/)
  })
})

describe('readAllowlist (injectable readFile — no real filesystem)', () => {
  it('reads and parses via an injected readFile', () => {
    const fakeReadFile = () => EMPTY_ALLOWLIST
    assert.deepEqual(readAllowlist('/some/path.json', fakeReadFile, TODAY), [])
  })

  it('throws a clear error when the file cannot be read (e.g. ENOENT)', () => {
    const fakeReadFile = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    }
    assert.throws(() => readAllowlist('/missing/path.json', fakeReadFile, TODAY), /could not read allowlist file/)
  })

  it('wires to the real filesystem by default (no injected readFile)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npm-audit-gate-allowlist-'))
    const file = path.join(dir, 'audit-allowlist.json')
    writeFileSync(file, EMPTY_ALLOWLIST)
    assert.deepEqual(readAllowlist(file, undefined, TODAY), [])
  })
})

describe('run (full injectable orchestration)', () => {
  it('clean audit + empty allowlist: passes end to end', () => {
    const result = run({
      argv: [],
      spawn: () => ({ stdout: JSON.stringify(CLEAN_AUDIT), stderr: '', status: 0, error: null }),
      readFile: () => EMPTY_ALLOWLIST,
      now: () => TODAY,
    })
    assert.equal(result.ok, true)
    assert.match(result.report, /npm-audit-gate: PASS/)
  })

  it('unwaived finding: fails end to end', () => {
    const result = run({
      argv: [],
      spawn: () => ({
        stdout: JSON.stringify(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')),
        stderr: '',
        status: 1,
        error: null,
      }),
      readFile: () => EMPTY_ALLOWLIST,
      now: () => TODAY,
    })
    assert.equal(result.ok, false)
    assert.match(result.report, /GHSA-AAAA-BBBB-CCCC/)
  })

  it('waived finding: passes end to end', () => {
    const result = run({
      argv: [],
      spawn: () => ({
        stdout: JSON.stringify(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')),
        stderr: '',
        status: 1,
        error: null,
      }),
      readFile: () => waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: '#1' }),
      now: () => TODAY,
    })
    assert.equal(result.ok, true)
  })

  it('propagates a malformed-allowlist failure end to end (fail closed)', () => {
    assert.throws(
      () =>
        run({
          argv: [],
          spawn: () => ({ stdout: JSON.stringify(CLEAN_AUDIT), stderr: '', status: 0, error: null }),
          readFile: () => '{not json',
          now: () => TODAY,
        }),
      /invalid JSON/,
    )
  })
})

describe('the real CLI process (npm-audit-gate-cli.mjs), invoked several ways (PR #193 review round 2)', () => {
  // Round 1 fixed a guard in npm-audit-gate.mjs that silently failed open
  // (exit 0, NO output) when invoked through a symlink or a spaced path.
  // Round 2's reviewer found one further miss (`--preserve-symlinks-main`)
  // and made the structural point that ANY guard's failure mode is
  // "silently never runs" — the wrong default for a deny-by-default
  // security gate. So npm-audit-gate.mjs now has NO guard and NO `main()`
  // at all; npm-audit-gate-cli.mjs is a tiny, unconditional, unguarded
  // entry point. These tests spawn THAT file as a REAL child `node`
  // process (not a unit test of guard logic, because there is none left to
  // unit-test) through the two forms that previously broke the guard
  // (symlink, spaced path) plus a direct invocation for a baseline — a
  // fake `npm` on PATH stands in for the real binary so this needs no real
  // project/lockfile and stays fast and deterministic.
  function makeFakeNpm(dir, json, exitCode) {
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npmPath = path.join(binDir, 'npm')
    writeFileSync(npmPath, `#!/usr/bin/env bash\ncat <<'AUDIT_JSON'\n${json}\nAUDIT_JSON\nexit ${exitCode}\n`)
    chmodSync(npmPath, 0o755)
    return binDir
  }

  function runCli(scriptPath, cwd, binDir) {
    return spawnSync('node', [scriptPath], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    })
  }

  function makeFixtureDir(prefix) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    writeFileSync(path.join(dir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    return dir
  }

  it('direct invocation, clean audit: real output, exit 0', () => {
    const dir = makeFixtureDir('npm-audit-gate-cli-direct-clean-')
    const binDir = makeFakeNpm(dir, JSON.stringify(CLEAN_AUDIT), 0)

    const result = runCli(CLI_SCRIPT_PATH, dir, binDir)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /npm-audit-gate: PASS/)
  })

  it('direct invocation, vulnerable audit: real output naming the advisory, exit 1', () => {
    const dir = makeFixtureDir('npm-audit-gate-cli-direct-vuln-')
    const findings = auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')
    const binDir = makeFakeNpm(dir, JSON.stringify(findings), 1)

    const result = runCli(CLI_SCRIPT_PATH, dir, binDir)

    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(result.stdout, /npm-audit-gate: FAIL/)
  })

  it('invoked through a SYMLINK, clean audit: real output, exit 0 (not a silent pass with no output)', () => {
    const dir = makeFixtureDir('npm-audit-gate-cli-symlink-clean-')
    const binDir = makeFakeNpm(dir, JSON.stringify(CLEAN_AUDIT), 0)
    const link = path.join(dir, 'npm-audit-gate-link.mjs')
    symlinkSync(CLI_SCRIPT_PATH, link)

    const result = runCli(link, dir, binDir)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /npm-audit-gate: PASS/)
  })

  it('invoked through a SYMLINK, vulnerable audit: real output naming the advisory, exit 1', () => {
    const dir = makeFixtureDir('npm-audit-gate-cli-symlink-vuln-')
    const findings = auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')
    const binDir = makeFakeNpm(dir, JSON.stringify(findings), 1)
    const link = path.join(dir, 'npm-audit-gate-link.mjs')
    symlinkSync(CLI_SCRIPT_PATH, link)

    const result = runCli(link, dir, binDir)

    // The bug this reproduces (round 1): BEFORE the fix, this would be
    // status 0 with EMPTY stdout — main() never ran because the entry-guard
    // comparison missed through the symlink. Now there is no guard to miss.
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(result.stdout, /npm-audit-gate: FAIL/)
  })

  it('invoked from a working directory containing a SPACE, clean audit: real output, exit 0', () => {
    // Round 1 fixed this case for the (now-removed) guard via unit tests
    // only; round 2 explicitly asks for the same real-child-process
    // treatment the symlink case got, not just unit coverage.
    const parent = mkdtempSync(path.join(tmpdir(), 'npm audit gate cli space '))
    const dir = path.join(parent, 'work dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    const binDir = makeFakeNpm(dir, JSON.stringify(CLEAN_AUDIT), 0)

    const result = runCli(CLI_SCRIPT_PATH, dir, binDir)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /npm-audit-gate: PASS/)
  })

  it('invoked from a working directory containing a SPACE, vulnerable audit: real output naming the advisory, exit 1', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'npm audit gate cli space '))
    const dir = path.join(parent, 'work dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    const findings = auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')
    const binDir = makeFakeNpm(dir, JSON.stringify(findings), 1)

    const result = runCli(CLI_SCRIPT_PATH, dir, binDir)

    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(result.stdout, /npm-audit-gate: FAIL/)
  })

  it('the CLI script ITSELF invoked via a path containing a space (not just its cwd): real output, exit 1', () => {
    // Belt-and-suspenders on top of the cwd-has-a-space cases above: this
    // copies the CLI file (and, via a relative import, the library) into a
    // spaced directory and invokes THAT path directly, closing the gap
    // between "spaced cwd" and "spaced script path" the way the symlink
    // cases already cover "symlinked script path" specifically.
    const spacedDir = mkdtempSync(path.join(tmpdir(), 'npm audit gate script space '))
    const cliCopy = path.join(spacedDir, 'npm-audit-gate-cli.mjs')
    const libCopy = path.join(spacedDir, 'npm-audit-gate.mjs')
    writeFileSync(cliCopy, readFileSync(CLI_SCRIPT_PATH, 'utf8'))
    writeFileSync(libCopy, readFileSync(LIB_SCRIPT_PATH, 'utf8'))
    writeFileSync(path.join(spacedDir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    const findings = auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')
    const binDir = makeFakeNpm(spacedDir, JSON.stringify(findings), 1)

    const result = runCli(cliCopy, spacedDir, binDir)

    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(result.stdout, /npm-audit-gate: FAIL/)
  })
})

describe('workflow wiring (the "never import for side effects" contract, PR #193 review round 3)', () => {
  // The library/CLI split (round 2) is documented, not enforced: nothing
  // stops a future edit from pointing a workflow step back at
  // `npm-audit-gate.mjs` directly — which has no guard and no `main()`, so
  // `node .github/scripts/npm-audit-gate.mjs` exits 0 with NO output,
  // silently green, for the exact same reason the original bug was a
  // silent pass. This is the third distinct silent-green shape found in
  // this file (round 1: the entry guard; round 2: the metadata
  // cross-check's blind spot; this: a workflow step pointed at the wrong
  // file) — cheap enough to make structural that there is no excuse not to.
  const workflowPaths = [
    path.join(REPO_ROOT, '.github', 'workflows', 'build.yml'),
    path.join(REPO_ROOT, '.github', 'workflows', 'nightly.yml'),
  ]

  for (const workflowPath of workflowPaths) {
    it(`${path.basename(workflowPath)} invokes npm-audit-gate-cli.mjs, not the guard-less library directly`, () => {
      const contents = readFileSync(workflowPath, 'utf8')
      assert.match(
        contents,
        /npm-audit-gate-cli\.mjs/,
        `${workflowPath} must invoke npm-audit-gate-cli.mjs — pointing at npm-audit-gate.mjs directly would silently exit 0 with no output (it has no entry guard by design; see that file's header)`,
      )
    })
  }
})
