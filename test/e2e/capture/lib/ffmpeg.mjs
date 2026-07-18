// Locates the ffmpeg binary Playwright already downloaded for its own
// (unused-by-us, see encode.mjs's doc comment) video recorder, so this
// harness doesn't need its own ffmpeg install. playwright-core doesn't
// export a stable path for this (its registry module isn't part of the
// package's public `exports`), so this walks the browsers cache directory
// it's known to unpack into instead. Overridable via FFMPEG_PATH for anyone
// whose cache lives somewhere nonstandard.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH
  }
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Caches', 'ms-playwright')
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? home, 'ms-playwright')
    default:
      return path.join(home, '.cache', 'ms-playwright')
  }
}

/** @returns {string} absolute path to the Playwright-bundled ffmpeg executable. */
export function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH
  }
  const root = browsersPath()
  const executableName =
    process.platform === 'win32'
      ? 'ffmpeg.exe'
      : `ffmpeg-${process.platform === 'darwin' ? 'mac' : 'linux'}`
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    throw new Error(
      `Could not read Playwright browsers cache at ${root} (${e.message}). ` +
        `Run "npx playwright install" in web/ first, or set FFMPEG_PATH explicitly.`,
    )
  }
  const ffmpegDir = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('ffmpeg-'))
    .sort((a, b) => b.name.localeCompare(a.name)) // newest revision first
    .at(0)
  if (!ffmpegDir) {
    throw new Error(
      `No ffmpeg-* directory found under ${root}. Run "npx playwright install" in web/ ` +
        `first, or set FFMPEG_PATH explicitly.`,
    )
  }
  const candidate = path.join(root, ffmpegDir.name, executableName)
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Expected ffmpeg at ${candidate} but it doesn't exist. Set FFMPEG_PATH explicitly.`,
    )
  }
  return candidate
}
