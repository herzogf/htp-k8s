#!/usr/bin/env node
// Offline encode step for the ADR-0011 layer-3 capture (issue #120): expands
// the raw, irregularly-timed CDP screencast frames captured by capture.mjs
// onto an exact 60fps timeline (each captured frame repeated for its true
// observed on-screen duration, using cumulative-rounding so repeat counts
// never drift), then pipes the resulting JPEG stream into the
// Playwright-bundled ffmpeg's image2pipe demuxer for a libvpx VP8 encode:
// -deadline good -cpu-used 1 -qmin 0 -qmax 20 -crf 6 -b:v 12M, 60fps CFR
// (the #116/#118 baseline's parameters — 12M is a ceiling, not a target).
//
// Page.startScreencast has NO frame-rate control knob: it delivers frames as
// fast as the renderer paints and the ack loop allows, and that rate varies
// run to run (observed 5.6fps-29fps on the same machine across the #116/#118
// captures). Naively concatenating captured frames at a fixed output rate
// would therefore produce a subtly WRONG-SPEED video. Instead, the repeat
// count for each frame is computed by lib/frameTiming.mjs's
// computeFrameRepeats — pure, unit-tested math extracted so this property
// (the single most important one this tool has to preserve) can be verified
// by a permanent regression test rather than just a one-off check.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { resolveFfmpeg } from './lib/ffmpeg.mjs'
import { computeFrameRepeats } from './lib/frameTiming.mjs'

const { values: args } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    output: { type: 'string' },
  },
})

if (!args['out-dir'] || !args.output) {
  console.error('Usage: encode.mjs --out-dir <dir> --output <path/to/clip.webm>')
  process.exit(1)
}

const OUT_DIR = args['out-dir']
const OUTPUT_WEBM = args.output
const FFMPEG = process.env.FFMPEG_PATH ?? resolveFfmpeg()

const FPS = 60

const frameMeta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'frame-meta.json'), 'utf8'))
frameMeta.sort((a, b) => a.elapsedMs - b.elapsedMs)

const { repeats, totalOutputFrames } = computeFrameRepeats(frameMeta, FPS)

const totalDurationSec = totalOutputFrames / FPS
console.log(
  `Expanding ${frameMeta.length} captured frames -> ${totalOutputFrames} output frames ` +
    `@ ${FPS}fps = ${totalDurationSec.toFixed(3)}s`,
)

fs.mkdirSync(path.dirname(OUTPUT_WEBM), { recursive: true })

const ffmpegArgs = [
  '-y',
  '-f',
  'image2pipe',
  '-vcodec',
  'mjpeg',
  '-framerate',
  String(FPS),
  '-i',
  'pipe:0',
  '-c:v',
  'libvpx',
  '-deadline',
  'good',
  '-cpu-used',
  '1',
  '-qmin',
  '0',
  '-qmax',
  '20',
  '-crf',
  '6',
  '-b:v',
  '12M',
  '-pix_fmt',
  'yuv420p',
  '-r',
  String(FPS),
  OUTPUT_WEBM,
]

console.log(`${FFMPEG} ${ffmpegArgs.join(' ')}`)
const ff = spawn(FFMPEG, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] })

let framesWritten = 0
async function writeAll() {
  for (let i = 0; i < frameMeta.length; i++) {
    const buf = await fs.promises.readFile(frameMeta[i].file)
    for (let r = 0; r < repeats[i]; r++) {
      const ok = ff.stdin.write(buf)
      framesWritten++
      if (!ok) {
        await new Promise((resolve) => ff.stdin.once('drain', resolve))
      }
    }
    if (i % 500 === 0) {
      console.log(
        `encoded input frame ${i}/${frameMeta.length} (output frames so far: ${framesWritten})`,
      )
    }
  }
  ff.stdin.end()
}

const exitP = new Promise((resolve, reject) => {
  ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  ff.on('error', reject)
})

await writeAll()
await exitP
console.log(`Done. Wrote ${framesWritten} output frames to ${OUTPUT_WEBM}`)
