// Bundled entry for the options page: installs, removes and speed-tests the optional HQ
// voices. It runs in the options page (not the offscreen document) because Chrome closes
// audio-only offscreen documents after 30 s without sound, which would interrupt a download.
import { install as installKokoro, isInstalled as kokoroInstalled, removeModel as removeKokoro } from '../offscreen/kokoro-core.js'
import { install as installParadee, isInstalled as paradeeInstalled, removeModel as removeParadee } from '../offscreen/paradee-core.js'

const CORES = {
  kokoro: { install: (arg, onMsg) => installKokoro(arg, onMsg), isInstalled: kokoroInstalled, remove: removeKokoro, worker: 'offscreen/worker.js' },
  paradee: { install: (arg, onMsg) => installParadee(onMsg), isInstalled: paradeeInstalled, remove: removeParadee, worker: 'offscreen/paradee-worker.js' },
}

const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it takes a short rest.'

function benchWorker(engine, messages) {
  const worker = new Worker(chrome.runtime.getURL(CORES[engine].worker), { type: 'module' })
  const run = (msg) => new Promise((resolve, reject) => {
    worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data))
    worker.onerror = (e) => reject(new Error(e.message || 'worker-failed'))
    worker.postMessage(msg)
  })
  return (async () => {
    try {
      let out
      for (const msg of messages) out = await run(msg)
      return out
    } finally {
      worker.terminate()
    }
  })()
}

// Both engines are measured the same way: load the model, speak a short line first, then
// time the sentence. rtf is seconds of generating per second of speech.
async function benchOnce(engine, threads) {
  if (engine === 'paradee') {
    const out = await benchWorker(engine, [{ id: 1, warm: true, threads }, { id: 2, bench: true, threads }])
    return Object.assign({ threads }, out.bench)
  }
  const t = performance.now()
  const out = await benchWorker(engine, [{ id: 1, text: 'Hello.', voice: 'af_heart', threads }, { id: 2, text: SENTENCE, voice: 'af_heart', threads }])
  const seconds = (performance.now() - t) / 1000
  const audio = out.samples.length / out.sr
  return { threads, seconds, audio, rtf: seconds / audio }
}

/** Measures generation speed. rtf < 1 means faster than real time (smooth playback). */
async function benchmark(engine, onStep) {
  const cores = navigator.hardwareConcurrency || 1
  const multi = Math.max(1, Math.min(4, cores - 1))
  const results = []
  for (const n of multi > 1 ? [1, multi] : [1]) {
    onStep && onStep(`Testing with ${n} thread${n > 1 ? 's' : ''}…`)
    results.push(await benchOnce(engine, n))
  }
  let gpu = false
  try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())) } catch (e) { /* none */ }
  return { cores, isolated: self.crossOriginIsolated, gpu, results }
}

window.HLInstaller = {
  install: (engine, arg, onMsg) => CORES[engine].install(arg, onMsg),
  isInstalled: (engine) => CORES[engine].isInstalled(),
  removeModel: (engine) => CORES[engine].remove(),
  benchmark: (engine, onStep) => benchmark(engine, onStep),
}
window.dispatchEvent(new Event('hl-installer-ready'))
