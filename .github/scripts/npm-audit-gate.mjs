#!/usr/bin/env node
// Gates `npm audit` behind a time-boxed allowlist (issue #189).
//
// Background: `npm audit` is a deliberately BLOCKING PR/nightly check
// (build.yml's Frontend (Node) job, nightly.yml's Nightly: Frontend (Node)
// job — ADR-0005). That's the right default. The gap #187/#189 surfaced:
// `govulncheck` is reachability-filtered (only symbols this code actually
// calls), so an unfixable-but-unreachable Go CVE never blocks a PR. `npm
// audit` has no equivalent — it flags by advisory + semver range with no
// reachability analysis, and this repo configures no `--audit-level`
// threshold and no override/ignore mechanism. An npm advisory with NO
// upstream fix would therefore block every PR indefinitely, with no
// documented way out, which is exactly the "unable to ship" scenario
// ADR-0005 already treats as unacceptable for the container-scan layer.
//
// This script is the escape hatch, and it is deliberately narrow:
//   - Default stays deny. Every advisory `npm audit` reports must be
//     covered by an allowlist entry, or the gate fails — this is NOT an
//     `--audit-level` threshold or a blanket dev-dependency exclusion.
//   - A waiver requires an expiry date, a reason, and a linked tracking
//     issue (`web/audit-allowlist.json`). No open-ended ignores.
//   - An EXPIRED waiver fails the build LOUDLY, even if the advisory it
//     names is no longer reported. A stale, silently-ignored waiver would
//     defeat the entire point of time-boxing it.
//   - Every parse/shape/validation failure fails closed (non-zero exit),
//     never silently passes — same instinct as
//     `.github/actions/govulncheck/action.yml`'s `blocking` input
//     validation, applied throughout: a typo'd date, an unparseable file, a
//     missing field, or an `npm audit` JSON shape this script doesn't
//     recognize is a FAILURE, not a pass.
//
// Deliberately a pure, importable set of functions (`extractAdvisories`,
// `parseAllowlist`, `evaluateGate`) with the CLI as a thin wrapper — same
// shape as `compute-image-tags.mjs`, for the same reason: the interesting
// logic gets real unit-test coverage (npm-audit-gate.test.mjs) independent
// of ever spawning npm.
//
// Usage: node npm-audit-gate.mjs [--cwd <dir>] [--allowlist <path>]
//   Run from `web/` (matches the CI step's job-default working-directory)
//   with no flags: spawns `npm audit --json` in the current directory and
//   reads ./audit-allowlist.json. Both are overridable for local use.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i
const GHSA_EXACT_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISSUE_REF_RE = /^(#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)$/

// ---------------------------------------------------------------------------
// npm audit JSON -> advisories
// ---------------------------------------------------------------------------

/**
 * Extract the set of advisories `npm audit --json` reported, keyed by GHSA
 * id. Deliberately strict about shape: this repo's npm (11.x, auditReportVersion
 * 2) always nests advisory detail — including the GHSA id, only ever present
 * as a URL — under each vulnerable package's `via` array. Anything that
 * doesn't match that shape is a finding this script cannot safely gate on,
 * so it throws rather than silently treating the report as clean.
 *
 * @param {unknown} auditJson - parsed `npm audit --json` output.
 * @returns {Map<string, {id: string, severity: string, title: string, packages: Set<string>}>}
 */
export function extractAdvisories(auditJson) {
  if (auditJson && typeof auditJson === 'object' && 'error' in auditJson) {
    const err = auditJson.error
    const summary = err && typeof err === 'object' && 'summary' in err ? err.summary : JSON.stringify(err)
    throw new Error(`npm audit reported an error rather than a report: ${summary}`)
  }

  if (
    !auditJson ||
    typeof auditJson !== 'object' ||
    Array.isArray(auditJson) ||
    typeof auditJson.vulnerabilities !== 'object' ||
    auditJson.vulnerabilities === null ||
    Array.isArray(auditJson.vulnerabilities)
  ) {
    throw new Error(
      'npm audit JSON: missing or malformed "vulnerabilities" object — refusing to treat this as a clean report (fail closed).',
    )
  }

  const advisories = new Map()

  for (const [pkgName, vuln] of Object.entries(auditJson.vulnerabilities)) {
    if (!vuln || typeof vuln !== 'object' || !Array.isArray(vuln.via)) {
      throw new Error(`npm audit JSON: vulnerability entry "${pkgName}" has no "via" array — unexpected shape.`)
    }

    for (const via of vuln.via) {
      // A bare string `via` entry is a reference to ANOTHER package name in
      // this same report (the dependency chain that pulled the vuln in) —
      // that package has its own entry with the real advisory detail, so
      // skip it here rather than double-counting or misreading a package
      // name as an advisory id.
      if (typeof via === 'string') continue

      if (!via || typeof via !== 'object') {
        throw new Error(`npm audit JSON: "${pkgName}" has a malformed "via" entry (${JSON.stringify(via)}).`)
      }

      const match = typeof via.url === 'string' ? via.url.match(GHSA_RE) : null
      if (!match) {
        throw new Error(
          `npm audit JSON: "${pkgName}" reports an advisory with no extractable GHSA id (url: ${via.url ?? '<missing>'}) — cannot gate on it safely.`,
        )
      }
      const id = match[0].toUpperCase()

      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          severity: typeof via.severity === 'string' ? via.severity : (vuln.severity ?? 'unknown'),
          title: typeof via.title === 'string' ? via.title : '(no title)',
          packages: new Set(),
        })
      }
      advisories.get(id).packages.add(pkgName)
    }
  }

  return advisories
}

// ---------------------------------------------------------------------------
// Allowlist parsing
// ---------------------------------------------------------------------------

function isValidIsoDate(s) {
  const m = ISO_DATE_RE.exec(s)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const dt = new Date(Date.UTC(year, month - 1, day))
  // Catches calendar nonsense (2026-02-30, 2026-13-01) that Date would
  // otherwise silently roll over into a different, wrong date.
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

/**
 * Parse and strictly validate the allowlist file's contents. Throws on ANY
 * malformed input — missing/wrong-shaped top level, a waiver missing a
 * required field, an unparseable or nonexistent-calendar-date `expires`, a
 * GHSA id that doesn't match the expected format, an `issue` field that
 * isn't a recognizable issue reference, or two waivers naming the same
 * advisory (ambiguous — which one governs?). Fail closed: an allowlist this
 * function can't fully validate is treated as broken, not as "no waivers".
 *
 * @param {string} raw - the allowlist file's raw text.
 * @returns {{id: string, expires: string, reason: string, issue: string}[]}
 */
export function parseAllowlist(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`audit-allowlist.json: invalid JSON — ${err instanceof Error ? err.message : err}`)
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('audit-allowlist.json: top level must be an object shaped { "waivers": [...] }.')
  }

  const { waivers } = data
  if (!Array.isArray(waivers)) {
    throw new Error('audit-allowlist.json: "waivers" must be an array (use [] for an empty allowlist).')
  }

  const seenIds = new Set()
  const parsed = []

  waivers.forEach((entry, index) => {
    const where = `audit-allowlist.json: waivers[${index}]`

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where}: must be an object.`)
    }

    const { id, expires, reason, issue } = entry

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${where}: missing required string field "id".`)
    }
    if (!GHSA_EXACT_RE.test(id)) {
      throw new Error(`${where}: "id" ("${id}") is not a well-formed GHSA advisory id (GHSA-xxxx-xxxx-xxxx).`)
    }
    const normalizedId = id.toUpperCase()

    if (typeof expires !== 'string' || expires.length === 0) {
      throw new Error(`${where} (${normalizedId}): missing required string field "expires".`)
    }
    if (!isValidIsoDate(expires)) {
      throw new Error(
        `${where} (${normalizedId}): "expires" ("${expires}") is not a valid ISO YYYY-MM-DD calendar date.`,
      )
    }

    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(`${where} (${normalizedId}): missing required non-empty string field "reason".`)
    }

    if (typeof issue !== 'string' || issue.trim().length === 0) {
      throw new Error(`${where} (${normalizedId}): missing required string field "issue".`)
    }
    if (!ISSUE_REF_RE.test(issue)) {
      throw new Error(
        `${where} (${normalizedId}): "issue" ("${issue}") must be a tracking issue reference — either "#123" or a full "https://github.com/<org>/<repo>/issues/<n>" URL.`,
      )
    }

    if (seenIds.has(normalizedId)) {
      throw new Error(`audit-allowlist.json: duplicate waiver for ${normalizedId} — one entry per advisory only.`)
    }
    seenIds.add(normalizedId)

    parsed.push({ id: normalizedId, expires, reason, issue })
  })

  return parsed
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

// A waiver is valid through the END of its `expires` date (inclusive) and
// expired starting the day after — pure date-only comparison (UTC midnight),
// deliberately ignoring time-of-day so the gate's result doesn't depend on
// what hour of the expiry date CI happens to run.
function isExpired(expiresIso, today) {
  const [, y, mo, d] = ISO_DATE_RE.exec(expiresIso)
  const expiresUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return todayUTC > expiresUTC
}

/**
 * Decide pass/fail given the advisories `npm audit` reported and the parsed
 * allowlist. Fails if ANY reported advisory lacks a non-expired waiver, OR
 * if ANY allowlist entry is itself expired — even one naming an advisory
 * that isn't currently reported (a stale waiver is a finding to clean up,
 * not something to silently ignore; see the module header).
 *
 * @param {Map<string, {id: string, severity: string, title: string, packages: Set<string>}>} advisories
 * @param {{id: string, expires: string, reason: string, issue: string}[]} waivers
 * @param {Date} today - injected so expiry logic is unit-testable without
 *   depending on the real clock. Callers pass `new Date()`.
 */
export function evaluateGate(advisories, waivers, today) {
  const waiverById = new Map(waivers.map((w) => [w.id, w]))
  const coveredIds = new Set()

  const activeWaivers = []
  const unwaivedFindings = []
  const expiredWaivers = []

  for (const advisory of advisories.values()) {
    const waiver = waiverById.get(advisory.id)
    if (!waiver) {
      unwaivedFindings.push(advisory)
      continue
    }
    coveredIds.add(waiver.id)
    if (isExpired(waiver.expires, today)) {
      expiredWaivers.push({ waiver, advisory })
    } else {
      activeWaivers.push({ waiver, advisory })
    }
  }

  // Waivers whose advisory ISN'T currently reported still must not be
  // expired — an expired-and-now-unreported waiver is exactly the "clean up
  // your stale waiver" case the module header calls out.
  for (const waiver of waivers) {
    if (coveredIds.has(waiver.id)) continue
    if (isExpired(waiver.expires, today)) {
      expiredWaivers.push({ waiver, advisory: null })
    }
  }

  const ok = unwaivedFindings.length === 0 && expiredWaivers.length === 0
  return { ok, activeWaivers, unwaivedFindings, expiredWaivers }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatDay(dateIso, today) {
  const [, y, mo, d] = ISO_DATE_RE.exec(dateIso)
  const expiresUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const days = Math.round((expiresUTC - todayUTC) / 86_400_000)
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`
  if (days === 0) return 'today (last valid day)'
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
}

export function formatReport({ ok, activeWaivers, unwaivedFindings, expiredWaivers }, today) {
  const lines = []
  lines.push('npm-audit-gate: evaluating npm audit findings against web/audit-allowlist.json')

  if (activeWaivers.length > 0) {
    lines.push('')
    lines.push(`Waived (${activeWaivers.length}):`)
    for (const { waiver, advisory } of activeWaivers) {
      lines.push(
        `  - ${waiver.id} (${advisory.severity}, ${[...advisory.packages].join(', ')}) — expires ${waiver.expires} (${formatDay(waiver.expires, today)}). Reason: ${waiver.reason}. Tracking: ${waiver.issue}`,
      )
    }
  }

  if (unwaivedFindings.length > 0) {
    lines.push('')
    lines.push(`FAILING — unwaived advisories (${unwaivedFindings.length}):`)
    for (const advisory of unwaivedFindings) {
      lines.push(
        `  - ${advisory.id} (${advisory.severity}, ${[...advisory.packages].join(', ')}): ${advisory.title}`,
      )
    }
    lines.push(
      '    Fix it, or add a time-boxed waiver to web/audit-allowlist.json (id, expires, reason, issue) — see docs/agents/findings.md.',
    )
  }

  if (expiredWaivers.length > 0) {
    lines.push('')
    lines.push(`FAILING — expired waivers (${expiredWaivers.length}):`)
    for (const { waiver, advisory } of expiredWaivers) {
      const status = advisory ? `still reported (${[...advisory.packages].join(', ')})` : 'no longer reported'
      lines.push(
        `  - ${waiver.id} expired ${waiver.expires} (${formatDay(waiver.expires, today)}), ${status}. Tracking: ${waiver.issue}`,
      )
    }
    lines.push('    Renew (new expiry, same rigor) or remove the stale entry from web/audit-allowlist.json.')
  }

  lines.push('')
  lines.push(ok ? 'npm-audit-gate: PASS' : 'npm-audit-gate: FAIL')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { cwd: process.cwd(), allowlist: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') args.cwd = argv[++i]
    else if (argv[i] === '--allowlist') args.allowlist = argv[++i]
    else throw new Error(`unrecognized argument: ${argv[i]}`)
  }
  if (!args.allowlist) args.allowlist = path.join(args.cwd, 'audit-allowlist.json')
  return args
}

function runNpmAudit(cwd) {
  const result = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) {
    throw new Error(`failed to run "npm audit --json" in ${cwd}: ${result.error.message}`)
  }
  // Deliberately NOT checking result.status here: npm audit exits non-zero
  // whenever it finds vulnerabilities (the whole point of it being
  // blocking), and still prints the full JSON report on stdout when it
  // does. A genuine operational failure (bad lockfile, registry error) is
  // instead caught by extractAdvisories() rejecting the `{"error": {...}}`
  // shape npm emits for that case, or by JSON.parse failing below.
  if (!result.stdout || result.stdout.trim().length === 0) {
    throw new Error(
      `"npm audit --json" in ${cwd} produced no stdout (exit ${result.status}). stderr:\n${result.stderr}`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(
      `"npm audit --json" in ${cwd} produced unparseable JSON: ${err instanceof Error ? err.message : err}`,
    )
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const auditJson = runNpmAudit(args.cwd)
  const advisories = extractAdvisories(auditJson)

  let allowlistRaw
  try {
    allowlistRaw = readFileSync(args.allowlist, 'utf8')
  } catch (err) {
    throw new Error(`could not read allowlist file ${args.allowlist}: ${err instanceof Error ? err.message : err}`)
  }
  const waivers = parseAllowlist(allowlistRaw)

  const today = new Date()
  const result = evaluateGate(advisories, waivers, today)
  console.log(formatReport(result, today))

  process.exitCode = result.ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::npm-audit-gate: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  })
}
