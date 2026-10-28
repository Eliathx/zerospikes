import type { MetricName } from "./types.js";

/**
 * Every number zerospikes judges a scenario by, in one place, each with where
 * it comes from. Kept as plain data so a config file can override it later.
 */

/**
 * What a scenario should stay under to feel smooth, whatever it measured
 * before. Over a target is a warning, never a failure: an app that already
 * lags still gets budgets that stop it getting worse.
 *
 * - `frame.max` 50 ms: a frame that takes longer is a long animation frame
 *   (W3C Long Animation Frames API), the point where a hitch is visible.
 * - `input.*` 50 ms: RAIL's budget for handling an input, so the visible
 *   response lands within 100 ms once queued work and the display add theirs.
 */
export const TARGETS: Partial<Record<MetricName, number>> = {
  "frame.max": 50,
  "input.down": 50,
  "input.move": 50,
  "input.up": 50,
  "input.click": 50,
  "input.key": 50,
  "input.wheel": 50,
};

/**
 * Room a recorded budget leaves above the worst of its runs, so another
 * browser session on the same machine doesn't fail it.
 *
 * Calibrated with `examples/20k-table/scripts/calibrate-slack.mjs` on 80
 * sessions of the example's six scenarios: 40 on a desktop (Ryzen 5 3500,
 * frames every 6.2 ms) on two days, idle and in light use, and 40 on GitHub's
 * ubuntu-latest runners (every 16.7 ms). Recording from each session and
 * checking every other one, these are the smallest values with no false
 * alarm. Re-run it with sessions of your own app to check them.
 *
 * They don't cover a machine busy with something heavy: in 20 sessions with a
 * game running, frame and input times moved up to ×3 and no slack was
 * enough, while CPU time stayed within these (see `calibration/busy`).
 */
export const SLACK = {
  /**
   * Frame and input times: the larger of a ratio and a number of display
   * frames, measured on the machine rather than assumed to be 60 Hz.
   * - Frames: a time lands a frame early or late from one session to the next
   *   even when nothing changed; with less than 2 frames, 102 of 27,360 checks
   *   failed in the first 60 sessions.
   * - Ratio: heavy interactions drift with the machine's state between
   *   sessions. Sorting, recorded at 51 ms, took up to 82 ms in a later session.
   */
  timeRatio: 1.6,
  timeFrames: 2,
  /**
   * Main-thread CPU time: it doesn't jump by frames, so the larger of a ratio
   * and a few milliseconds. Light interactions move the most: opening the
   * detail panel, recorded at 9.7 ms, took 21.7 ms in another session of the
   * same day, which the 12 ms cover. Above that, ×1.45 is the smallest ratio
   * with no false alarm in any session, the busy ones included, so a time
   * over budget with CPU time within it points at another program.
   */
  cpuRatio: 1.45,
  cpuMs: 12,
  /**
   * Counts of slow and long frames: they come from the same timing noise, so
   * the time ratio, plus one more frame. Not tested beyond the counts the
   * example has, which stay at 0 or 1 in every session.
   */
  countExtra: 1,
  /**
   * Memory left after the cycles. Not calibrated: the example's one memory
   * scenario leaves 0 nodes, 0 listeners and 0.1–0.2 MB in every session, too
   * little to say how much they vary.
   */
  heapRatio: 1.25,
  heapMB: 2,
  nodes: 50,
  listeners: 5,
};

/**
 * How much lower a budget recorded now would be, before suggesting `-u` to
 * tighten it: the same 10% `zerospikes compare` takes as the smallest change
 * worth failing for.
 */
export const TIGHTEN_MIN_GAIN = 0.1;

/** Display frame assumed when a scenario recorded no frames to measure it from (memory cycles). */
export const FALLBACK_FRAME_MS = 1000 / 60;
