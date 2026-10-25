// Small PCM helpers shared by the HQ engines. Pure functions so they can be unit tested.

/**
 * Trim the silence a TTS model leaves at the edges of a buffer.
 *
 * Paradee and Kokoro both start an input with ~300 ms of silence and end it with ~500 ms
 * (measured). Speech is generated ahead of playback, so that silence is not hidden by
 * generation time — it is exactly what a listener hears as a pause between sentences.
 * The margins stay generous: enough lead that a soft first consonant is never clipped,
 * enough trail that the last word can decay instead of being cut off.
 *
 * Returns the same buffer untouched when trimming would gain nothing.
 */
export function trimEdges(wave, sr, { leadMs = 70, trailMs = 150 } = {}) {
  const n = wave.length
  if (n < Math.max(1, Math.round(sr / 10))) return wave
  let peak = 0
  for (let i = 0; i < n; i++) { const a = Math.abs(wave[i]); if (a > peak) peak = a }
  if (peak < 1e-4) return wave // digital silence: nothing to trim
  const thr = Math.max(0.008, peak * 0.012)
  let a = 0
  while (a < n && Math.abs(wave[a]) < thr) a++
  let b = n - 1
  while (b >= a && Math.abs(wave[b]) < thr) b--
  if (b < a) return wave
  const from = Math.max(0, a - Math.round(sr * leadMs / 1000))
  const to = Math.min(n, b + 1 + Math.round(sr * trailMs / 1000))
  if (from <= 0 && to >= n) return wave
  return wave.subarray(from, to)
}

/** Milliseconds of silence before the first sample above the noise floor (diagnostics/tests). */
export function leadSilenceMs(wave, sr, thr = 0.008) {
  let a = 0
  while (a < wave.length && Math.abs(wave[a]) < thr) a++
  return (a / sr) * 1000
}

/** Milliseconds of silence after the last sample above the noise floor. */
export function trailSilenceMs(wave, sr, thr = 0.008) {
  let b = wave.length - 1
  while (b >= 0 && Math.abs(wave[b]) < thr) b--
  return ((wave.length - 1 - b) / sr) * 1000
}
