// Permanent regression suite for analyzePoseTrace and its building blocks
// (issue #120): the 0.3s saturation-cluster merge (without which capture
// jitter fragments one continuous pan into dozens of meaningless blips — see
// analysis.mjs's module doc comment) and a fixture-pinned reproduction of the
// #118-iter3 baseline capture's recorded analysis output (the validation this
// tool depended on before landing, per the #120 PR discussion — kept here so
// it is re-runnable, not just a one-off claim in a PR description).

import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzePoseTrace, saturationClusters } from './analysis.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '__fixtures__')

describe('saturationClusters (the 0.3s merge)', () => {
  it('merges jittered fragments of one continuous pan into a single cluster', () => {
    // Simulates the exact failure mode the module doc comment describes:
    // one physically-continuous turn, but per-sample capture/async-evaluate
    // jitter leaves small (<0.3s) sub-threshold gaps inside it.
    const series = [
      [10.0, 1.5],
      [10.15, -1.6], // sign shouldn't matter — clusters key off |rate|
      [10.44, 1.55], // gap from 10.15 is 0.29s -> merges
      [10.73, 1.7], // gap from 10.44 is 0.29s -> merges (peak of this cluster)
    ]
    const clusters = saturationClusters(series, 1.47, 0.3)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual({ start: 10.0, end: 10.73, duration: 0.73, n: 4, peak: 1.7 })
  })

  it('keeps adjacent-but-genuinely-separate events separate', () => {
    const series = [
      [10.0, 1.5],
      [10.15, 1.55],
      [10.44, 1.7], // one cluster: 10.00-10.44
      [10.75, 1.52], // gap from 10.44 is 0.31s (> 0.3) -> a new, separate event
      [10.91, 1.61], // gap from 10.75 is 0.16s -> merges into the second cluster
    ]
    const clusters = saturationClusters(series, 1.47, 0.3)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toEqual({ start: 10.0, end: 10.44, duration: 0.44, n: 3, peak: 1.7 })
    expect(clusters[1]).toEqual({ start: 10.75, end: 10.91, duration: 0.16, n: 2, peak: 1.61 })
  })

  it('pins the exact merge-boundary behavior at gap == gapMerge vs gap > gapMerge', () => {
    // The implementation merges on `gap > gapMerge`, i.e. a gap exactly
    // equal to the threshold still merges — pin that boundary explicitly so
    // a future `>` <-> `>=` flip is caught immediately.
    const exactlyAtBoundary = saturationClusters(
      [
        [0, 1.5],
        [0.3, 1.5], // gap is EXACTLY 0.3 -> merges (not > gapMerge)
      ],
      1.47,
      0.3,
    )
    expect(exactlyAtBoundary).toHaveLength(1)

    const justOverBoundary = saturationClusters(
      [
        [0, 1.5],
        [0.30001, 1.5], // gap is just over 0.3 -> separate
      ],
      1.47,
      0.3,
    )
    expect(justOverBoundary).toHaveLength(2)
  })

  it('filters out samples below threshold entirely, including ones that would otherwise bridge a gap', () => {
    const series = [
      [0, 1.5],
      [0.1, 1.0], // below threshold: not part of any cluster, and does not bridge the gap
      [0.2, 1.5],
    ]
    const clusters = saturationClusters(series, 1.47, 0.3)
    // Both over-threshold samples are within 0.3s of EACH OTHER (0.2s apart,
    // ignoring the filtered-out middle sample entirely) so they still merge.
    expect(clusters).toHaveLength(1)
    expect(clusters[0].n).toBe(2)
  })

  it('a version without the merge step would fail the "jittered fragments" test above', () => {
    // Demonstrates why the merge step is required, matching analysis.mjs's
    // module doc comment claim directly: without it, each over-threshold
    // sample is trivially its own "cluster", fragmenting one visually
    // continuous pan into several meaningless blips.
    function saturationClustersWithoutMerge(rateSeries, threshold) {
      return rateSeries
        .filter(([, r]) => Math.abs(r) >= threshold)
        .map(([t, r]) => ({ start: t, end: t, duration: 0, n: 1, peak: Math.abs(r) }))
    }
    const series = [
      [10.0, 1.5],
      [10.15, 1.6],
      [10.44, 1.55],
      [10.73, 1.7],
    ]
    const unmerged = saturationClustersWithoutMerge(series, 1.47)
    expect(unmerged).toHaveLength(4) // fragmented, not the single real event
    expect(saturationClusters(series, 1.47, 0.3)).toHaveLength(1) // the real function does not fragment it
  })
})

describe('analyzePoseTrace — fixture regression (#118-iter3 baseline capture)', () => {
  const samples = JSON.parse(
    fs.readFileSync(join(FIXTURES, 'pr118-iter3-pose-samples.json'), 'utf8'),
  )
  const expected = JSON.parse(
    fs.readFileSync(join(FIXTURES, 'pr118-iter3-pose-analysis.json'), 'utf8'),
  )
  // Matches analyze.mjs's CLI defaults (--max-yaw-rate 1.5 --saturation-fraction
  // 0.98) that produced the recorded expected fixture — see analyze.mjs for
  // why the threshold is derived rather than hardcoded.
  const threshold = 1.5 * 0.98

  it('reproduces the recorded turn timestamps, saturation clusters, and sample counts', () => {
    const result = analyzePoseTrace(samples, { threshold, label: 'test', source: 'test' })

    expect(result.n_samples).toBe(expected.n_samples)
    expect(result.duration_s).toBe(expected.duration_s)
    expect(result.avg_native_spacing_ms).toBe(expected.avg_native_spacing_ms)
    expect(result.downsampled_n).toBe(expected.downsampled_n)
    expect(result.n_saturation_clusters).toBe(expected.n_saturation_clusters)

    // Turn/cluster timestamps and counts are exact (they never go through a
    // transcendental function); yaw_rate/peak derive from atan2 and carry
    // ~1e-13-1e-14 relative floating-point noise between engine builds (see
    // the #120 PR discussion) — close-enough rather than bit-exact equality
    // for exactly those two fields.
    expect(result.strongest_turns).toHaveLength(expected.strongest_turns.length)
    result.strongest_turns.forEach((turn, i) => {
      const exp = expected.strongest_turns[i]
      expect(turn.t).toBe(exp.t)
      expect(turn.yaw_rate).toBeCloseTo(exp.yaw_rate, 9)
    })

    expect(result.saturation_clusters).toHaveLength(expected.saturation_clusters.length)
    result.saturation_clusters.forEach((cluster, i) => {
      const exp = expected.saturation_clusters[i]
      expect(cluster.start).toBe(exp.start)
      expect(cluster.end).toBe(exp.end)
      expect(cluster.duration).toBe(exp.duration)
      expect(cluster.n).toBe(exp.n)
      expect(cluster.peak).toBeCloseTo(exp.peak, 9)
    })
  })
})
