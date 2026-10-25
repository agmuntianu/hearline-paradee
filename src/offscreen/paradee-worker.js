// Dedicated worker for the Paradee voice: inference stays off the offscreen document's
// main thread, so playback and progress reporting keep running while a sentence is made.
// It is a separate worker from the Kokoro one on purpose: neither engine pays to load the
// other's runtime.
import { generate, benchmark, loadModel, usableThreads } from './paradee-core.js'

let cancelled = 0

self.onmessage = async (e) => {
  const m = e.data || {}
  // A cancel while a run is in flight: the current generation finishes (it is a fraction
  // of a second) and its result is dropped instead of being played.
  if (m.cancel) { cancelled++; return }
  try {
    if (m.bench) {
      const r = await benchmark({ threads: m.threads })
      self.postMessage({ id: m.id, bench: r })
      return
    }
    const myToken = cancelled
    if (m.warm) {
      await loadModel({ threads: m.threads })
      await generate('Yes.', { speed: 1, threads: m.threads })
      self.postMessage({ id: m.id, warm: true, threads: usableThreads(m.threads) })
      return
    }
    const out = await generate(m.text, { speed: m.speed, threads: m.threads })
    if (cancelled !== myToken) { self.postMessage({ id: m.id, cancelled: true }); return }
    self.postMessage(
      { id: m.id, samples: out.samples, sr: out.sr, speed: out.speed, windows: out.windows, weights: out.weights, phonemes: out.phonemes },
      [out.samples.buffer]
    )
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) })
  }
}
