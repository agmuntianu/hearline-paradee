// Dedicated worker: runs Kokoro inference off the page's main thread.
import { loadModel, setThreads } from './kokoro-core.js'
import { trimEdges } from '../shared/pcm.js'

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.threads) setThreads(m.threads) // only the first message matters (benchmarking)
    const tts = await loadModel()
    const out = await tts.generate(m.text, { voice: m.voice, speed: 1 })
    // Kokoro pads every request with silence; that pad is the pause between sentences, so
    // it goes before the audio is handed to playback.
    const samples = trimEdges(out.audio, out.sampling_rate)
    self.postMessage({ id: m.id, samples, sr: out.sampling_rate }, [samples.buffer])
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) })
  }
}
