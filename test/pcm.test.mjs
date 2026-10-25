import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimEdges, leadSilenceMs, trailSilenceMs } from '../src/shared/pcm.js'

const SR = 24000

/** A quiet-then-loud-then-quiet buffer that looks like what a TTS model returns. */
function clip(leadMs, voicedMs, trailMs, amp = 0.5) {
  const n = Math.round(SR * (leadMs + voicedMs + trailMs) / 1000)
  const w = new Float32Array(n)
  const a = Math.round(SR * leadMs / 1000)
  const b = Math.round(SR * (leadMs + voicedMs) / 1000)
  for (let i = a; i < b; i++) w[i] = amp * Math.sin(i * 0.05)
  return w
}

test('the model edge silence is trimmed down to the margins', () => {
  const out = trimEdges(clip(300, 2000, 500), SR)
  assert.ok(leadSilenceMs(out, SR) <= 75, `lead ${leadSilenceMs(out, SR).toFixed(0)} ms`)
  assert.ok(leadSilenceMs(out, SR) >= 60, 'keeps a little lead so the first consonant survives')
  assert.ok(trailSilenceMs(out, SR) <= 155, `trail ${trailSilenceMs(out, SR).toFixed(0)} ms`)
  assert.ok(trailSilenceMs(out, SR) >= 140, 'keeps a little trail so the last word decays')
  const saved = (300 + 500) - (leadSilenceMs(out, SR) + trailSilenceMs(out, SR))
  assert.ok(saved > 500, `a sentence boundary loses most of its dead air (${saved.toFixed(0)} ms)`)
})

test('audio that already fits the margins is returned untouched', () => {
  const w = clip(50, 1000, 100)
  assert.equal(trimEdges(w, SR), w, 'same buffer, no copy')
})

test('pure silence is never trimmed away', () => {
  const w = new Float32Array(SR)
  assert.equal(trimEdges(w, SR), w)
})

test('a very short buffer is left alone', () => {
  const w = clip(10, 40, 10)
  assert.equal(trimEdges(w, SR), w)
})

test('a quiet recording is trimmed by its own level, not an absolute one', () => {
  const out = trimEdges(clip(300, 2000, 500, 0.02), SR)
  assert.ok(out.length < clip(300, 2000, 500, 0.02).length - SR * 0.5, 'quiet audio still gets trimmed')
  assert.ok(leadSilenceMs(out, SR, 0.0005) <= 80, `lead ${leadSilenceMs(out, SR, 0.0005).toFixed(0)} ms`)
})

test('trimming keeps every sample of the voiced part', () => {
  const w = clip(300, 2000, 500)
  const out = trimEdges(w, SR)
  const a = Math.round(SR * 300 / 1000)
  const b = Math.round(SR * 2300 / 1000)
  const expected = w.subarray(a, b)
  const got = out.subarray(Math.round(SR * 70 / 1000), out.length - Math.round(SR * 150 / 1000))
  assert.equal(got.length, expected.length)
  for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - expected[i]) < 1e-9)
})
