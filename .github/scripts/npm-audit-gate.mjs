#!/usr/bin/env node
// Gates `npm audit` behind a time-boxed allowlist (issue #189). Decision
// record + full rationale: ADR-0005. Day-to-day how-to (adding a waiver):
// docs/agents/findings.md. This header covers only what a reader of the
// CODE needs, not a restatement of either.
//
// This script is deliberately narrow: default stays deny (every reported
// advisory needs a covering, non-expired `web/audit-allowlist.json` entry
// or the gate fails), a waiver is capped at MAX_WAIVER_HORIZON_DAYS out so
// "time-boxed" is structural rather than honor-system, and an EXPIRED
// waiver fails the build even if its advisory is no longer reported (a
// stale waiver is a cleanup finding, not a free pass). Every
// parse/shape/validation failure fails closed — same instinct as
// `.github/actions/govulncheck/action.yml`'s `blocking` input validation.
//
// Known limitation (PR #193 review): a `via` entry whose advisory URL
// isn't GHSA-shaped (e.g. npm's old numeric `npmjs.com/advisories/N` form)
// makes extractAdvisories() throw, and there is then no id to put in the
// allowlist — fails closed, but with no waiver path. This has not been
// observed against this repo's npm (11.x reports GHSA URLs universally);
// treat a real occurrence as a bug against this script, not something to
// work around by hand-editing a non-GHSA id into the allowlist (parseAllowlist
// rejects it too).
//
// Deliberately a pure, importable core (`extractAdvisories`, `parseAllowlist`,
// `evaluateGate`, `formatReport`) PLUS an injectable orchestrator (`run`) —
// same shape as `compute-image-tags.mjs` for the pure core, extended here
// (PR #193 review round 1) because the CLI layer itself (argv parsing,
// spawning npm, reading the allowlist file) is exactly where a fail-open bug
// lived and unit tests must reach it too, not just the pure functions
// underneath it. `npm-audit-gate.test.mjs` covers both layers without ever
// touching a real npm process or the real filesystem.
//
// THIS FILE HAS NO ENTRY-POINT GUARD AND NO `main()` (PR #193 review round
// 2). Round 1 fixed a naive `import.meta.url === \`file://${process.argv[1]}\``
// guard that silently failed open — exited 0 with NO output — when invoked
// through a symlink or a path containing a space; the fix (comparing a
// realpath'd, properly-encoded URL) closed both, but the reviewer found one
// residual miss (`node --preserve-symlinks-main`) and made the sharper
// point: the failure mode of ANY such guard is "silently never runs" in a
// deny-by-default security gate, however narrow the remaining aperture. A
// guard that doesn't exist cannot miss. So this file is a pure library with
// no side effect on import, and `npm-audit-gate-cli.mjs` — a few lines,
// unconditional, unguarded — is the only thing CI actually invokes. Import
// `run()` (or the individual functions) directly for tests; run the CLI
// file directly to execute the gate for real.
//
// Usage (via the CLI file): node npm-audit-gate-cli.mjs [--cwd <dir>] [--allowlist <path>]
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

// A waiver more than this many days out isn't "time-boxed", it's a
// disguised standing ignore — caps how far into the future `expires` may
// be set at parse time (PR #193 review). The gap between `expires` and
// "now" only shrinks as time passes, so a waiver valid under this cap when
// written stays valid under it for the rest of its life; this never turns a
// previously-accepted waiver into a parse failure later.
export const MAX_WAIVER_HORIZON_DAYS = 180

function daysBetween(dateIso, today) {
  const [, y, mo, d] = ISO_DATE_RE.exec(dateIso)
  const targetUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((targetUTC - todayUTC) / 86_400_000)
}

// ---------------------------------------------------------------------------
// npm audit JSON -> advisories
// ---------------------------------------------------------------------------

/**
 * Extract the set of advisories `npm audit --json` reported, keyed by GHSA
 * id. Deliberately strict about shape: this repo's npm (11.x, auditReportVersion
 * 2) always nests advisory detail — including the GHSA id, only ever present
 * as a URL — under each vulnerable package's `via` array. Anything that
 * doesn't match that shape is a finding this script cannot safely gate on,
 * so it throws rather than silently treating the report as clean. Two
 * structural invariants are enforced unconditionally (PR #193 review round
 * 2): every key in `vulnerabilities` must resolve to a real advisory,
 * directly or transitively through its `via` chain (a closed loop or a
 * dead end fails, even if OTHER packages in the same report resolve fine);
 * and `metadata.vulnerabilities.total` must be present, numeric, and equal
 * to the package count — not merely "greater than zero when nothing was
 * extracted", which missed both of the above.
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

  const vulnerabilities = auditJson.vulnerabilities
  const advisories = new Map()
  // Packages with at least one real advisory OBJECT in their own "via"
  // array (as opposed to only string references to other packages) — the
  // "terminal" nodes the reachability check below walks string chains
  // toward. Tracked separately from `advisories` because more than one
  // package can resolve to the same GHSA id (dedup), but every package
  // still needs its OWN resolvability checked.
  const directlyResolved = new Set()

  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    if (!vuln || typeof vuln !== 'object' || !Array.isArray(vuln.via) || vuln.via.length === 0) {
      throw new Error(
        `npm audit JSON: vulnerability entry "${pkgName}" has no non-empty "via" array — unexpected shape.`,
      )
    }

    for (const via of vuln.via) {
      // A bare string `via` entry is a reference to ANOTHER package name in
      // this same report (the dependency chain that pulled the vuln in) —
      // that package's OWN entry carries the real advisory detail, so this
      // one is skipped rather than double-counted. But the reference must
      // actually resolve: a string naming a package that isn't itself a key
      // in `vulnerabilities` is a malformed/incomplete report (PR #193
      // review round 1) — silently skipping it would mean a report whose
      // `via` chains are ALL such dangling strings extracts zero advisories
      // and gates GREEN despite reporting vulnerabilities. Fail closed
      // instead. (Whether the reference resolves to a REAL advisory,
      // transitively, is checked separately below — this only checks that
      // the name exists at all.)
      if (typeof via === 'string') {
        if (!Object.prototype.hasOwnProperty.call(vulnerabilities, via)) {
          throw new Error(
            `npm audit JSON: "${pkgName}"'s "via" references "${via}", which is not itself a reported vulnerability — malformed/incomplete report, cannot safely resolve this advisory.`,
          )
        }
        continue
      }

      if (!via || typeof via !== 'object') {
        throw new Error(`npm audit JSON: "${pkgName}" has a malformed "via" entry (${JSON.stringify(via)}).`)
      }

      const match = typeof via.url === 'string' ? via.url.match(GHSA_RE) : null
      if (!match) {
        throw new Error(
          `npm audit JSON: "${pkgName}" reports an advisory with no extractable GHSA id (url: ${via.url ?? '<missing>'}) — cannot gate on it safely. See this script's header ("Known limitation") if it genuinely isn't a GHSA advisory.`,
        )
      }
      const id = match[0].toUpperCase()
      directlyResolved.add(pkgName)

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

  // Structural invariant (PR #193 review round 2): every key in
  // `vulnerabilities` must resolve to at least one real advisory, either
  // directly or transitively through its "via" string chain. Round 1's
  // check (fail only when `advisories.size === 0` overall) missed two
  // sibling shapes: a closed loop of string references with NO metadata at
  // all (the "vulnerabilities" cross-check never even ran), and a PARTIAL
  // loss where some packages resolve fine and others don't (the non-empty
  // `advisories` map masked the unresolved ones). This walks each
  // package's chain with cycle detection (`visiting`) — a cycle among
  // packages that never reaches a real advisory resolves to `false`, not a
  // silent pass.
  const resolvable = new Map()
  function isResolvable(pkgName, visiting) {
    if (resolvable.has(pkgName)) return resolvable.get(pkgName)
    if (directlyResolved.has(pkgName)) {
      resolvable.set(pkgName, true)
      return true
    }
    if (visiting.has(pkgName)) return false // cycle on this path; don't memoize yet — a sibling edge may still resolve
    visiting.add(pkgName)
    let result = false
    for (const via of vulnerabilities[pkgName].via) {
      if (typeof via === 'string' && isResolvable(via, visiting)) {
        result = true
        break
      }
    }
    visiting.delete(pkgName)
    resolvable.set(pkgName, result)
    return result
  }
  for (const pkgName of Object.keys(vulnerabilities)) {
    if (!isResolvable(pkgName, new Set())) {
      throw new Error(
        `npm audit JSON: "${pkgName}" resolves to no real advisory, directly or transitively through its "via" chain — malformed/incomplete report, refusing to treat this as clean (fail closed).`,
      )
    }
  }

  // Mandatory cross-check against npm's own summary count (PR #193 review
  // round 2). Real npm audit (auditReportVersion 2, npm 11.x) always sets
  // `metadata.vulnerabilities.total` to the number of top-level vulnerable
  // PACKAGES — i.e. `Object.keys(vulnerabilities).length` — not the number
  // of distinct advisories. Required unconditionally (missing or
  // non-numeric fails closed, regardless of whether the reachability
  // invariant above already passed) and compared for an EXACT match, so a
  // tampered or truncated `vulnerabilities` object can't slip past just
  // because every key it DOES list happens to resolve.
  const reportedTotal = auditJson.metadata?.vulnerabilities?.total
  if (typeof reportedTotal !== 'number') {
    throw new Error(
      'npm audit JSON: "metadata.vulnerabilities.total" is missing or not a number — cannot cross-check the report, refusing to treat this as clean (fail closed).',
    )
  }
  const packageCount = Object.keys(vulnerabilities).length
  if (reportedTotal !== packageCount) {
    throw new Error(
      `npm audit JSON: metadata reports ${reportedTotal} vulnerable package(s) but "vulnerabilities" lists ${packageCount} — mismatched report, refusing to treat this as clean (fail closed).`,
    )
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
 * required field, an unparseable or nonexistent-calendar-date `expires`, an
 * `expires` further out than `MAX_WAIVER_HORIZON_DAYS`, a GHSA id that
 * doesn't match the expected format, an `issue` field that isn't a
 * recognizable issue reference, or two waivers naming the same advisory
 * (ambiguous — which one governs?). Fail closed: an allowlist this function
 * can't fully validate is treated as broken, not as "no waivers".
 *
 * @param {string} raw - the allowlist file's raw text.
 * @param {Date} [today] - injected so the horizon-cap check is
 *   unit-testable without depending on the real clock. Defaults to `new
 *   Date()` for real callers.
 * @returns {{id: string, expires: string, reason: string, issue: string}[]}
 */
export function parseAllowlist(raw, today = new Date()) {
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
    const horizonDays = daysBetween(expires, today)
    if (horizonDays > MAX_WAIVER_HORIZON_DAYS) {
      throw new Error(
        `${where} (${normalizedId}): "expires" ("${expires}") is ${horizonDays} days out, past the ${MAX_WAIVER_HORIZON_DAYS}-day cap — waivers must be genuinely time-boxed. Pick a nearer re-check date; renew later if still needed.`,
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
  return daysBetween(expiresIso, today) < 0
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
  const days = daysBetween(dateIso, today)
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

export function parseArgs(argv) {
  const args = { cwd: process.cwd(), allowlist: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') args.cwd = argv[++i]
    else if (argv[i] === '--allowlist') args.allowlist = argv[++i]
    else throw new Error(`unrecognized argument: ${argv[i]}`)
  }
  if (!args.allowlist) args.allowlist = path.join(args.cwd, 'audit-allowlist.json')
  return args
}

/**
 * Run `npm audit --json` and return its parsed output. `spawn` is
 * injectable (defaults to `child_process.spawnSync`) so this — including
 * the "npm couldn't be spawned at all", "produced no stdout", and
 * "produced unparseable JSON" failure branches — is unit-testable without
 * a real npm process (PR #193 review).
 *
 * @param {string} cwd
 * @param {typeof import('node:child_process').spawnSync} [spawn]
 */
export function runNpmAudit(cwd, spawn = spawnSync) {
  const result = spawn('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
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

/**
 * Read and parse the allowlist file. `readFile` is injectable (defaults to
 * `fs.readFileSync`) so a missing/unreadable file is unit-testable without
 * touching the real filesystem (PR #193 review).
 *
 * @param {string} allowlistPath
 * @param {typeof import('node:fs').readFileSync} [readFile]
 * @param {Date} [today]
 */
export function readAllowlist(allowlistPath, readFile = readFileSync, today = new Date()) {
  let raw
  try {
    raw = readFile(allowlistPath, 'utf8')
  } catch (err) {
    throw new Error(`could not read allowlist file ${allowlistPath}: ${err instanceof Error ? err.message : err}`)
  }
  return parseAllowlist(raw, today)
}

/**
 * The full gate, end to end, with every external effect (argv, spawning
 * npm, reading the allowlist, the clock) injectable — this is what
 * `npm-audit-gate.test.mjs` exercises as "the CLI layer" without ever
 * spawning a real npm process or touching the real filesystem (PR #193
 * review round 1). `npm-audit-gate-cli.mjs` is the real, non-injected
 * wiring — see this file's header for why THIS file has no entry-point
 * guard, and no `main()`, at all (PR #193 review round 2).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {typeof import('node:child_process').spawnSync} [opts.spawn]
 * @param {typeof import('node:fs').readFileSync} [opts.readFile]
 * @param {() => Date} [opts.now]
 * @returns {{ok: boolean, report: string}}
 */
export function run({ argv = process.argv.slice(2), spawn = spawnSync, readFile = readFileSync, now = () => new Date() } = {}) {
  const args = parseArgs(argv)
  const auditJson = runNpmAudit(args.cwd, spawn)
  const advisories = extractAdvisories(auditJson)
  const today = now()
  const waivers = readAllowlist(args.allowlist, readFile, today)
  const result = evaluateGate(advisories, waivers, today)
  return { ok: result.ok, report: formatReport(result, today) }
}
