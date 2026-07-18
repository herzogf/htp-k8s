#!/usr/bin/env node
// ADR-0011 layer-3 authoritative video capture harness — the capture half
// (see encode.mjs for the offline encode, analyze.mjs/proximity.mjs/
// stills.mjs for the analysis outputs). Committed per issue #120 from the
// #118 capture's reference implementation.
//
// Drives the real built app (already running, expected to have Demo Mode
// auto-started via HTP_K8S_DEMO=1 / HTP_K8S_DEMO_SEED, see run.sh) via a
// headless Chromium tab, captures raw CDP Page.startScreencast frames (JPEG
// quality 100, native viewport resolution, every frame), and records two
// parallel traces:
//   - a pose sample (position + quaternion) alongside every captured frame,
//     read through window.__htpCameraTest (FreeFlyControls.tsx) — the same
//     read-only hook the Playwright e2e suite uses;
//   - the real Tower world-space layout, read off the /ws SceneState
//     broadcast the same way web/e2e/demo-canyon-tour.spec.ts does, so the
//     proximity/stills analysis can key off genuine placements instead of a
//     hardcoded grid assumption.
//
// Frames are written to disk with their observed wall-clock arrival time so
// encode.mjs can hold each one for its true on-screen duration.
//
// Deliberately NOT using Playwright's built-in page.video() recorder: its
// internal ffmpeg preset scales to fit 800x800 at a low bitrate, destroying
// the micro-motion detail this review depends on (see docs/running-locally.md
// and ADR-0011).

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    'duration-ms': { type: 'string', default: '132000' },
    'base-url': { type: 'string', default: 'http://localhost:8080' },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '900' },
  },
})

if (!args['out-dir']) {
  console.error(
    'Usage: capture.mjs --out-dir <dir> [--duration-ms 132000] [--base-url http://localhost:8080] [--width 1600] [--height 900]',
  )
  process.exit(1)
}

const OUT_DIR = args['out-dir']
const TARGET_DURATION_MS = Number(args['duration-ms'])
const BASE_URL = args['base-url']
const WIDTH = Number(args.width)
const HEIGHT = Number(args.height)

const FRAMES_DIR = path.join(OUT_DIR, 'frames')
fs.mkdirSync(FRAMES_DIR, { recursive: true })

const frameMeta = [] // { index, elapsedMs, file }
const poseSamples = [] // { elapsedMs, pos, quat }
let towers = null // [{ name, grid: { col, row } }] from the /ws SceneState snapshot

let startTime = null
let frameCount = 0
let stopping = false

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page console error]', msg.text())
  })
  page.on('pageerror', (err) => console.error('[page error]', err))

  // Learn the real Tower layout from the /ws SceneState snapshot (same frame
  // web/e2e/demo-canyon-tour.spec.ts reads), for proximity.mjs/stills.mjs.
  const sceneStateFrame = new Promise((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return
        let frame
        try {
          frame = JSON.parse(payload)
        } catch {
          return
        }
        if (Array.isArray(frame.towers)) resolve(frame.towers)
      })
    })
  })

  console.log(`Navigating to ${BASE_URL} ...`)
  await page.goto(BASE_URL, { waitUntil: 'load' })

  towers = await sceneStateFrame
  console.log(`Learned ${towers.length} Tower placement(s) from the /ws SceneState snapshot.`)

  // Wait for the camera test hook and confirm Demo Mode is active before we
  // start burning capture time.
  await page.waitForFunction(() => Boolean(window.__htpCameraTest), null, {
    timeout: 30_000,
  })
  const demoActive = await page.evaluate(() => window.__htpCameraTest.isDemoActive())
  console.log('Demo Mode active at capture start:', demoActive)
  if (!demoActive) {
    throw new Error(
      'Demo Mode did not auto-start — aborting capture (would not match the requested clip).',
    )
  }

  const cdp = await context.newCDPSession(page)

  const framePromises = []

  cdp.on('Page.screencastFrame', (params) => {
    const now = Date.now()
    if (startTime === null) startTime = now
    const elapsedMs = now - startTime
    const idx = frameCount++
    const file = path.join(FRAMES_DIR, `f${String(idx).padStart(6, '0')}.jpg`)

    // Ack immediately to keep frames flowing; write to disk async.
    cdp
      .send('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch((e) => console.error('ack failed', e))

    const buf = Buffer.from(params.data, 'base64')
    const writeP = fs.promises.writeFile(file, buf)
    framePromises.push(writeP)
    frameMeta.push({ index: idx, elapsedMs, file })

    // Sample pose alongside this frame (best-effort; don't block the ack).
    if (!stopping) {
      page
        .evaluate(() => {
          const hook = window.__htpCameraTest
          if (!hook) return null
          return { pos: hook.getPosition(), quat: hook.getQuaternion() }
        })
        .then((pose) => {
          if (pose) poseSamples.push({ elapsedMs, pos: pose.pos, quat: pose.quat })
        })
        .catch(() => {})
    }

    if (idx % 50 === 0) {
      console.log(`frame ${idx} @ ${(elapsedMs / 1000).toFixed(1)}s`)
    }
  })

  console.log(`Starting screencast (jpeg q=100, native ${WIDTH}x${HEIGHT}, every frame)...`)
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 100,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  })

  await new Promise((resolve) => setTimeout(resolve, TARGET_DURATION_MS))

  stopping = true
  console.log('Stopping screencast...')
  await cdp.send('Page.stopScreencast')
  // Let any in-flight evaluate()/writeFile() calls settle.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await Promise.allSettled(framePromises)

  await browser.close()

  frameMeta.sort((a, b) => a.elapsedMs - b.elapsedMs)
  poseSamples.sort((a, b) => a.elapsedMs - b.elapsedMs)

  fs.writeFileSync(path.join(OUT_DIR, 'frame-meta.json'), JSON.stringify(frameMeta, null, 2))
  fs.writeFileSync(
    path.join(OUT_DIR, 'pose-samples.json'),
    JSON.stringify(
      poseSamples.map((p) => ({
        elapsedMs: p.elapsedMs,
        pos: p.pos,
        quat: p.quat,
      })),
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(OUT_DIR, 'towers.json'), JSON.stringify(towers, null, 2))

  console.log(
    `Captured ${frameMeta.length} frames, ${poseSamples.length} pose samples, ${towers.length} towers.`,
  )
  console.log(`Last frame elapsedMs: ${frameMeta[frameMeta.length - 1]?.elapsedMs}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
