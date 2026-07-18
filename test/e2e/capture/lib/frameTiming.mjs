// Pure frame-timing math for encode.mjs's offline exact-speed encode (issue
// #120, ADR-0011 layer 3). Split out of encode.mjs so it's importable and
// unit-testable without spawning ffmpeg or touching the filesystem — this is
// the single most important property the harness has to preserve (see the
// module doc comment below), so it needs a permanent regression test, not
// just a one-off validation in a PR description.
//
// Page.startScreencast has NO frame-rate control knob: it delivers frames as
// fast as the renderer paints and the ack loop allows, and that rate varies
// run to run (observed 5.6fps-29fps on the same machine across different
// captures). Naively concatenating captured frames at a fixed output rate
// would therefore produce a subtly WRONG-SPEED video. Instead, frame i is
// held for output-frame ticks round(elapsedMs[i+1]/frameMs) -
// round(elapsedMs[i]/frameMs) — the boundary-rounding (not
// round(duration/frameMs) applied per-frame) is what keeps rounding error
// from accumulating across a multi-thousand-frame capture: the total output
// frame count is exactly round(totalDurationMs/frameMs), never drifting high
// or low regardless of how irregular the input spacing is.

/**
 * @typedef {{ elapsedMs: number }} TimedFrame
 */

/**
 * Computes, for each captured frame (sorted ascending by `elapsedMs`), how
 * many `fps`-rate output-frame ticks it should be repeated for so the
 * encoded clip's total duration and per-frame hold times match the frames'
 * true observed on-screen durations, with no cumulative rounding drift.
 *
 * Each frame covers wall-clock time [elapsedMs[i], elapsedMs[i+1]) (the last
 * frame is given one output tick's worth of time, since there's no next
 * frame to bound it). A frame is always held for at least 1 tick — two
 * source frames landing in the same output tick (source frame-to-frame
 * spacing tighter than 1/fps, not observed at this tool's ~5-30fps capture
 * rates but not impossible) forces that tick's count up by 1, so the
 * output's total frame count can very slightly exceed
 * `round(totalDurationMs/frameMs)` in that edge case — harmless in practice,
 * but not a strict equality.
 *
 * @param {readonly TimedFrame[]} frameMeta sorted ascending by elapsedMs
 * @param {number} fps output frame rate (e.g. 60)
 * @returns {{ repeats: number[], totalOutputFrames: number }} repeats[i] is
 *   how many times frameMeta[i] should be written to the output stream
 */
export function computeFrameRepeats(frameMeta, fps) {
  const frameMs = 1000 / fps
  let totalOutputFrames = 0
  const repeats = []
  for (let i = 0; i < frameMeta.length; i++) {
    const startMs = frameMeta[i].elapsedMs
    const endMs = i + 1 < frameMeta.length ? frameMeta[i + 1].elapsedMs : startMs + frameMs
    const startTick = Math.round(startMs / frameMs)
    const endTick = Math.round(endMs / frameMs)
    const n = Math.max(1, endTick - startTick)
    repeats.push(n)
    totalOutputFrames += n
  }
  return { repeats, totalOutputFrames }
}
