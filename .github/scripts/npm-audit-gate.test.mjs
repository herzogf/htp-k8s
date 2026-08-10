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

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateGate, extractAdvisories, formatReport, parseAllowlist } from './npm-audit-gate.mjs'

const TODAY = new Date('2026-08-10T12:00:00Z')

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
      metadata: {},
    }
    const advisories = extractAdvisories(audit)
    assert.equal(advisories.size, 1)
    assert.deepEqual([...advisories.get('GHSA-AAAA-BBBB-CCCC').packages].sort(), ['a', 'b'])
  })

  it('skips string `via` entries (dependency-chain references, not advisories)', () => {
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
      metadata: {},
    }
    const advisories = extractAdvisories(audit)
    assert.deepEqual([...advisories.keys()], ['GHSA-AAAA-BBBB-CCCC'])
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
      /has no "via" array/,
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
})

describe('parseAllowlist', () => {
  it('an empty waivers array parses to no waivers', () => {
    assert.deepEqual(parseAllowlist(EMPTY_ALLOWLIST), [])
  })

  it('parses a well-formed waiver and normalizes the id to uppercase', () => {
    const waivers = parseAllowlist(
      waiverList({
        id: 'ghsa-aaaa-bbbb-cccc',
        expires: '2026-09-01',
        reason: 'no upstream fix; dev-only tooling',
        issue: '#999',
      }),
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
    )
    assert.equal(waivers[0].issue, 'https://github.com/herzogf/htp-k8s/issues/999')
  })

  it('throws on invalid top-level JSON', () => {
    assert.throws(() => parseAllowlist('{not json'), /invalid JSON/)
  })

  it('throws when top level is not an object shaped { waivers: [...] }', () => {
    assert.throws(() => parseAllowlist('[]'), /top level must be an object/)
    assert.throws(() => parseAllowlist('null'), /top level must be an object/)
    assert.throws(() => parseAllowlist(JSON.stringify({ waivers: 'nope' })), /"waivers" must be an array/)
  })

  it('throws when a waiver is missing "id"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ expires: '2026-09-01', reason: 'r', issue: '#1' })),
      /missing required string field "id"/,
    )
  })

  it('throws on a malformed GHSA id', () => {
    assert.throws(
      () =>
        parseAllowlist(waiverList({ id: 'not-a-ghsa-id', expires: '2026-09-01', reason: 'r', issue: '#1' })),
      /not a well-formed GHSA advisory id/,
    )
  })

  it('throws when a waiver is missing "expires"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', reason: 'r', issue: '#1' })),
      /missing required string field "expires"/,
    )
  })

  it('throws on a malformed expires date (bad format)', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '09/01/2026', reason: 'r', issue: '#1' }),
        ),
      /not a valid ISO YYYY-MM-DD/,
    )
  })

  it('throws on a calendar-invalid expires date (e.g. Feb 30)', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-02-30', reason: 'r', issue: '#1' }),
        ),
      /not a valid ISO YYYY-MM-DD/,
    )
  })

  it('throws when a waiver is missing "reason"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', issue: '#1' })),
      /missing required non-empty string field "reason"/,
    )
  })

  it('throws when "reason" is blank', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: '   ', issue: '#1' }),
        ),
      /missing required non-empty string field "reason"/,
    )
  })

  it('throws when a waiver is missing "issue"', () => {
    assert.throws(
      () => parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r' })),
      /missing required string field "issue"/,
    )
  })

  it('throws when "issue" is not a recognizable tracking-issue reference', () => {
    assert.throws(
      () =>
        parseAllowlist(
          waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: 'see slack' }),
        ),
      /must be a tracking issue reference/,
    )
  })

  it('throws on duplicate waivers for the same advisory', () => {
    const entry = { id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'r', issue: '#1' }
    assert.throws(() => parseAllowlist(waiverList(entry, { ...entry, expires: '2026-10-01' })), /duplicate waiver/)
  })

  it('throws when a waiver entry itself is not an object', () => {
    assert.throws(() => parseAllowlist(JSON.stringify({ waivers: ['GHSA-aaaa-bbbb-cccc'] })), /must be an object/)
  })
})

describe('evaluateGate (two-state + expiry behaviour)', () => {
  it('clean audit + empty allowlist: passes', () => {
    const result = evaluateGate(extractAdvisories(CLEAN_AUDIT), parseAllowlist(EMPTY_ALLOWLIST), TODAY)
    assert.equal(result.ok, true)
    assert.deepEqual(result.unwaivedFindings, [])
    assert.deepEqual(result.expiredWaivers, [])
  })

  it('unwaived advisory: fails', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const result = evaluateGate(advisories, parseAllowlist(EMPTY_ALLOWLIST), TODAY)
    assert.equal(result.ok, false)
    assert.equal(result.unwaivedFindings.length, 1)
    assert.equal(result.unwaivedFindings[0].id, 'GHSA-AAAA-BBBB-CCCC')
  })

  it('a validly (non-expired) waived advisory: passes', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-09-01', reason: 'no fix upstream yet', issue: '#500' }),
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, true)
    assert.equal(result.activeWaivers.length, 1)
  })

  it('a waiver expiring exactly today is still valid (inclusive last day)', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-08-10', reason: 'r', issue: '#500' }),
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    assert.equal(result.ok, true)
  })

  it('EXPIRED waiver (advisory still reported): fails', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const waivers = parseAllowlist(
      waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-08-09', reason: 'r', issue: '#500' }),
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
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-01-01', reason: 'r', issue: '#500' })),
      TODAY,
    )
    assert.equal(result.ok, false)
    assert.equal(result.expiredWaivers.length, 1)
    assert.equal(result.expiredWaivers[0].advisory, null)
  })

  it('a NON-expired waiver whose advisory is gone is harmless (not yet due for cleanup)', () => {
    const result = evaluateGate(
      extractAdvisories(CLEAN_AUDIT),
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-12-31', reason: 'r', issue: '#500' })),
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
    const result = evaluateGate(extractAdvisories(CLEAN_AUDIT), parseAllowlist(EMPTY_ALLOWLIST), TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /npm-audit-gate: PASS/)
  })

  it('produces a human-readable FAIL summary naming the unwaived advisory', () => {
    const advisories = extractAdvisories(auditWithFindings('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'))
    const result = evaluateGate(advisories, parseAllowlist(EMPTY_ALLOWLIST), TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /npm-audit-gate: FAIL/)
    assert.match(report, /GHSA-AAAA-BBBB-CCCC/)
  })

  it('produces a human-readable summary naming an expired waiver and its tracking issue', () => {
    const result = evaluateGate(
      extractAdvisories(CLEAN_AUDIT),
      parseAllowlist(waiverList({ id: 'GHSA-aaaa-bbbb-cccc', expires: '2026-01-01', reason: 'r', issue: '#500' })),
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
    )
    const result = evaluateGate(advisories, waivers, TODAY)
    const report = formatReport(result, TODAY)
    assert.match(report, /Waived/)
    assert.match(report, /no fix yet/)
    assert.match(report, /2026-09-01/)
  })
})
