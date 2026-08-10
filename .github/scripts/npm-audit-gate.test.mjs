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
// Two layers are covered, deliberately (PR #193 review — the original
// version of this suite covered only the pure functions, and the reported
// fail-open bug lived in the CLI layer that was untested):
//   1. The pure core: extractAdvisories, parseAllowlist, evaluateGate,
//      formatReport — no I/O, no clock dependency (Date injected).
//   2. The CLI layer: parseArgs, runNpmAudit, readAllowlist, run(), and the
//      ESM entry-point guard (isMainModule) — exercised either via
//      dependency injection (fake spawn/readFile functions, no real npm or
//      filesystem touched) or, for the entry-guard fix specifically, via an
//      actual child `node` process invoked through a real symlink — that
//      exact reproduction is what caught the bug, so it stays as a real
//      regression test rather than being weakened into a pure unit test.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  evaluateGate,
  extractAdvisories,
  formatReport,
  isMainModule,
  MAX_WAIVER_HORIZON_DAYS,
  parseAllowlist,
  parseArgs,
  readAllowlist,
  run,
  runNpmAudit,
} from './npm-audit-gate.mjs'

const TODAY = new Date('2026-08-10T12:00:00Z')
const SCRIPT_PATH = fileURLToPath(new URL('./npm-audit-gate.mjs', import.meta.url))

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

  it('throws when every "via" is a closed loop of valid-looking string references with no terminal advisory object (metadata cross-check)', () => {
    // Both string references here DO resolve to real vulnerabilities-map
    // keys (so the dangling-reference check above does not fire), but
    // neither entry ever carries a real advisory object — the closed loop
    // extracts zero advisories despite metadata.total reporting 2. This is
    // exactly the belt-and-suspenders case the metadata cross-check exists
    // to catch.
    const audit = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: ['b'] },
        b: { name: 'b', severity: 'high', via: ['a'] },
      },
      metadata: { vulnerabilities: { total: 2 } },
    }
    assert.throws(() => extractAdvisories(audit), /metadata reports 2 vulnerabilities but no advisory could be extracted/)
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

describe('isMainModule (the entry-guard fail-open fix, PR #193 review)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-audit-gate-mainmodule-'))
  const realFile = path.join(dir, 'script.mjs')
  writeFileSync(realFile, '// fixture')
  // A real `import.meta.url` is always a well-formed, percent-encoded file
  // URL (that's how Node's ESM loader produces it) — build the fixture the
  // same way, via pathToFileURL, rather than naive string concatenation
  // (which is exactly the bug this function fixes).
  const realUrl = pathToFileURL(realpathSync(realFile)).href

  it('true when argv[1] IS the file (direct invocation)', () => {
    assert.equal(isMainModule(realUrl, realFile), true)
  })

  it('true when argv[1] is a SYMLINK to the file — this is the bug the naive string comparison missed', () => {
    const link = path.join(dir, 'link.mjs')
    symlinkSync(realFile, link)
    assert.equal(isMainModule(realUrl, link), true)
    // The naive comparison this replaced would have failed here:
    assert.notEqual(realUrl, `file://${link}`)
  })

  it('true when argv[1] is a path containing a space — percent-encoding must not break the match', () => {
    const spacedDir = mkdtempSync(path.join(tmpdir(), 'npm audit gate space '))
    const spacedFile = path.join(spacedDir, 'script.mjs')
    writeFileSync(spacedFile, '// fixture')
    const spacedUrl = pathToFileURL(realpathSync(spacedFile)).href
    assert.equal(isMainModule(spacedUrl, spacedFile), true)
    // The naive comparison this replaced would have failed here: a real
    // import.meta.url percent-encodes the space, but building a URL by
    // naive template-string concatenation of the raw path does not — the
    // two never matched under the old `import.meta.url === \`file://\${argv[1]}\``
    // check.
    assert.notEqual(spacedUrl, `file://${spacedFile}`)
  })

  it('false when argv[1] is missing (e.g. imported, not run as a script)', () => {
    assert.equal(isMainModule(realUrl, undefined), false)
    assert.equal(isMainModule(realUrl, null), false)
  })

  it('false when argv[1] points at a different, unrelated file', () => {
    const other = path.join(dir, 'other.mjs')
    writeFileSync(other, '// fixture')
    assert.equal(isMainModule(realUrl, other), false)
  })

  it('false (not throwing) when argv[1] does not resolve to a real file on disk', () => {
    assert.equal(isMainModule(realUrl, path.join(dir, 'does-not-exist.mjs')), false)
  })
})

describe('the real CLI process, invoked through a symlink (end-to-end reproduction of the #193 fail-open)', () => {
  // This is deliberately a REAL child `node` process, not a unit test of
  // isMainModule alone: the bug this guards against is specifically that
  // running the actual script file through a symlinked path silently exited
  // 0 with NO output. A fake `npm` on PATH stands in for the real binary so
  // this needs no real project/lockfile and stays fast and deterministic.
  function makeFakeNpm(dir, json, exitCode) {
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npmPath = path.join(binDir, 'npm')
    writeFileSync(npmPath, `#!/usr/bin/env bash\ncat <<'AUDIT_JSON'\n${json}\nAUDIT_JSON\nexit ${exitCode}\n`)
    chmodSync(npmPath, 0o755)
    return binDir
  }

  function runViaSymlink(dir, binDir) {
    const link = path.join(dir, 'npm-audit-gate-link.mjs')
    symlinkSync(SCRIPT_PATH, link)
    return spawnSync('node', [link], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    })
  }

  it('clean audit through a symlink: real output, exit 0 (not a silent pass with no output)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npm-audit-gate-e2e-clean-'))
    writeFileSync(path.join(dir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    const binDir = makeFakeNpm(dir, JSON.stringify(CLEAN_AUDIT), 0)

    const result = runViaSymlink(dir, binDir)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /npm-audit-gate: PASS/)
  })

  it('vulnerable audit through a symlink: real output naming the advisory, exit 1', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npm-audit-gate-e2e-vuln-'))
    writeFileSync(path.join(dir, 'audit-allowlist.json'), EMPTY_ALLOWLIST)
    const findings = auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc')
    const binDir = makeFakeNpm(dir, JSON.stringify(findings), 1)

    const result = runViaSymlink(dir, binDir)

    // The bug this reproduces: BEFORE the fix, this would be status 0 with
    // EMPTY stdout — main() never ran because the entry-guard comparison
    // missed through the symlink. Asserting non-zero + real content is the
    // literal regression guard.
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /GHSA-AAAA-BBBB-CCCC/)
    assert.match(result.stdout, /npm-audit-gate: FAIL/)
  })
})
