/**
 * Per-device latency calibration.
 *
 * Hardware timestamps get us most of the way, but some devices misreport latency by
 * 5–40 ms (DSP effects, Bluetooth, vendor HALs). We measure the residual once and store it.
 *
 *  1. Loopback (preferred, no human error): play a click chart through the SPEAKER with
 *     the calibration offset set to 0; the mic hears the clicks. Residual = median of
 *     (detected songMs - click songMs).
 *  2. Play-along (headphones): the user picks an open string on each click. This also
 *     absorbs the player's own anticipation bias (people tap ~10–30 ms early), so it can
 *     mask genuine rushing — use it only when loopback is impossible.
 *
 * The native side *subtracts* the offset, so newOffset = currentOffset + measuredResidual.
 */
export interface CalibrationResult {
  offsetMs: number;
  spreadMs: number; // median absolute deviation — quality indicator
  samples: number;
  reliable: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function estimateCalibration(
  clickTimesMs: number[],
  detectedSongMs: number[],
  currentOffsetMs = 0,
  maxPairingMs = 250,
): CalibrationResult {
  const diffs: number[] = [];
  for (const d of detectedSongMs) {
    let best = Infinity;
    for (const c of clickTimesMs) if (Math.abs(d - c) < Math.abs(best)) best = d - c;
    if (Math.abs(best) <= maxPairingMs) diffs.push(best);
  }
  if (diffs.length < 4) return { offsetMs: currentOffsetMs, spreadMs: Infinity, samples: diffs.length, reliable: false };
  const med = median(diffs);
  const mad = median(diffs.map((x) => Math.abs(x - med)));
  return {
    offsetMs: currentOffsetMs + med,
    spreadMs: mad,
    samples: diffs.length,
    // Loopback typically gives MAD < 2 ms; > 8 ms means a noisy room or a human in the loop.
    reliable: diffs.length >= Math.min(8, clickTimesMs.length * 0.6) && mad < 8,
  };
}
