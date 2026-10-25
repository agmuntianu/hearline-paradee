// Shared by the offscreen document (playback) and the options page (install).
import { KokoroTTS } from 'kokoro-js'
import { env } from '@huggingface/transformers'

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

env.allowLocalModels = false
// CPU (wasm) build only: skips the 21 MB WebGPU variant. Resolved relative to the bundle
// (dist/offscreen/*.js or dist/options/*.js), so it also works inside a worker.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../ort/ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('../ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
}
// Multi-threaded WASM needs cross-origin isolation, enabled in the manifest.
env.backends.onnx.wasm.numThreads = 1
env.backends.onnx.wasm.proxy = false

export function setThreads(n) { env.backends.onnx.wasm.numThreads = n }

export const progressHandlers = new Set()
let ttsPromise = null

export const modelLoaded = () => !!ttsPromise

export function loadModel() {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => progressHandlers.forEach((h) => h(p)),
    }).catch((e) => {
      ttsPromise = null
      throw e
    })
  }
  return ttsPromise
}

// ONNX sessions are not re-entrant: run every generation one at a time.
let chain = Promise.resolve()
export function enqueue(fn) {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

/** Download the model (and warm the given voices). onMsg receives { t, pct, label, message }. */
export async function install(voices, onMsg) {
  let biggest = { loaded: 0, total: 0 }
  const files = new Map()
  const handler = (p) => {
    if (p.status !== 'progress' || !p.file || !(p.total > 1e6)) return // ignore tiny config files
    files.set(p.file, { loaded: p.loaded, total: p.total })
    for (const f of files.values()) if (f.total > biggest.total) biggest = f
    onMsg({ t: 'install-progress', pct: Math.min(90, Math.round((biggest.loaded / Math.max(1, biggest.total)) * 90)), label: 'Downloading voice model' })
  }
  progressHandlers.add(handler)
  try {
    onMsg({ t: 'install-progress', pct: 1, label: 'Starting download' })
    const tts = await loadModel()
    for (let i = 0; i < voices.length; i++) {
      onMsg({ t: 'install-progress', pct: 90 + Math.round((10 * i) / voices.length), label: `Preparing voices (${i + 1}/${voices.length})` })
      await enqueue(() => tts.generate('Hello.', { voice: voices[i], speed: 1 }))
    }
    onMsg({ t: 'install-done' })
  } catch (e) {
    onMsg({ t: 'install-error', message: String((e && e.message) || e) })
  } finally {
    progressHandlers.delete(handler)
  }
}

export async function isInstalled() {
  try {
    const cache = await caches.open('transformers-cache')
    return (await cache.keys()).some((r) => r.url.includes('model_quantized'))
  } catch (e) {
    return false
  }
}

export async function removeModel() {
  await caches.delete('transformers-cache')
  await caches.delete('kokoro-js')
}
