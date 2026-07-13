/**
 * PULSE_PERIOD_MS is how long one traveling pulse takes to cross a lane
 * end-to-end (t = 0 to t = 1), for the decorative source below. Kept as a
 * fixed *time*, not a fixed world-space speed, so every lane's pulses complete
 * a crossing in the same duration regardless of how long that particular lane
 * is (a v1 simplification appropriate for purely decorative motion — CONTEXT.md's
 * Floor Lane is "not driven by real cluster data" in v1).
 */
const PULSE_PERIOD_MS = 2200

/**
 * PULSES_PER_LANE is how many pulses are in flight on a single lane at once,
 * evenly spaced around the cycle, so a lane reads as a steady stream of light
 * rather than one blip every {@link PULSE_PERIOD_MS}.
 */
export const PULSES_PER_LANE = 2

/**
 * LanePulse is one traveling light pulse's current state on a lane: how far
 * along it is and how bright it should render. It is the pure, per-frame output
 * a {@link LaneActivitySource} hands to the renderer — deliberately just two
 * numbers, so a future real-data source (traffic volume, request rate, …) can
 * drive `intensity` (and even how many pulses exist) from a real signal without
 * the renderer changing at all.
 */
export interface LanePulse {
  /** Fractional position along the lane, from `start` (0) to `end` (1). */
  t: number
  /** Brightness of this pulse, 0..1 (0 = invisible, 1 = full brightness). */
  intensity: number
}

/**
 * LaneActivitySource is the seam between "what pulses are on a Floor Lane right
 * now" and how they are drawn (see {@link FloorLanes}). This is the interface
 * acceptance criterion #2 of issue #28 asks for: v1 ships only
 * {@link decorativeLaneActivitySource} (CONTEXT.md: Floor Lanes are decorative
 * in v1, "reserved for later wiring to a real traffic or control-plane
 * signal"), but any later ticket that wants pulses to reflect a real signal
 * (inter-node traffic, control-plane calls, …) only has to write a new
 * implementation of this one method and pass it to `<FloorLanes
 * activitySource={...} />` (see that component's `activitySource` prop) — no
 * change to lane geometry ({@link laneRoutes}) or the renderer itself. Per
 * ADR-0002, such a real source would also need to degrade gracefully (e.g. fall
 * back to the decorative source, or report no pulses) when its cluster
 * dependency isn't present — that policy lives in the future implementation,
 * not in this interface.
 */
export interface LaneActivitySource {
  /**
   * The pulses currently traveling on the lane identified by `laneId` (see
   * {@link LanePlacement.id}), at time `now` (milliseconds, any monotonic clock
   * as long as the caller is consistent — the renderer uses `performance.now()`).
   * Returns `[]` for a lane with no current activity.
   */
  pulsesFor(laneId: string, now: number): LanePulse[]
}

/**
 * A small, fast string hash (djb2-ish) used only to derive a deterministic
 * per-lane phase offset below — not cryptographic, just enough spread that
 * different lane ids don't all pulse in lockstep.
 */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) >>> 0
  }
  return hash
}

/** Positive modulo (JS's `%` can return negative for a negative dividend). */
function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

/**
 * The pure envelope behind {@link decorativeLaneActivitySource}: computes
 * {@link PULSES_PER_LANE} pulses evenly spaced around a {@link PULSE_PERIOD_MS}
 * cycle, phase-shifted per `laneId` (via {@link hashString}) so neighbouring
 * lanes don't all pulse in visible unison. Exported separately from the
 * `LaneActivitySource` object so it can be unit-tested directly as a plain
 * function of `(laneId, now)`.
 */
export function decorativePulsesFor(laneId: string, now: number): LanePulse[] {
  const laneOffset = hashString(laneId) % PULSE_PERIOD_MS
  const pulses: LanePulse[] = []
  for (let i = 0; i < PULSES_PER_LANE; i++) {
    const pulseOffset = (i * PULSE_PERIOD_MS) / PULSES_PER_LANE
    const elapsed = mod(now + laneOffset + pulseOffset, PULSE_PERIOD_MS)
    pulses.push({ t: elapsed / PULSE_PERIOD_MS, intensity: 1 })
  }
  return pulses
}

/**
 * The v1 default {@link LaneActivitySource}: decorative, deterministic,
 * endlessly traveling pulses with no dependency on real cluster data (CONTEXT.md;
 * ADR-0002 — Floor Lanes work identically on any cluster, with or without a
 * service mesh/traffic signal available). This is what {@link FloorLanes} uses
 * unless a later ticket passes a different `activitySource`.
 */
export const decorativeLaneActivitySource: LaneActivitySource = {
  pulsesFor: decorativePulsesFor,
}
