#!/usr/bin/env node
// The real, unguarded CLI entry point for npm-audit-gate.mjs (issue #189,
// PR #193 review round 2).
//
// Deliberately tiny and deliberately has NO "am I the entry point" guard:
// see npm-audit-gate.mjs's own header for why. In short — round 1 fixed a
// guard that silently failed open (exited 0, no output) when invoked
// through a symlink or a spaced path; the reviewer then found one further
// miss (`node --preserve-symlinks-main`) and made the structural point that
// ANY such guard's failure mode is "silently never runs", which is the
// wrong default for a deny-by-default security gate. So this file carries
// no guard logic at all — it exists ONLY to be run, unconditionally, as a
// script. It must never be imported for its side effects (it has one: it
// spawns `npm audit`); `npm-audit-gate.mjs` is the thing to import in tests
// or other tooling.
//
// This is what both build.yml and nightly.yml actually invoke:
//   node npm-audit-gate-cli.mjs [--cwd <dir>] [--allowlist <path>]

import { run } from './npm-audit-gate.mjs'

async function main() {
  const { ok, report } = run()
  console.log(report)
  process.exitCode = ok ? 0 : 1
}

main().catch((err) => {
  console.error(`::error::npm-audit-gate: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
