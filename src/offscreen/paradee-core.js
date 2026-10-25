// Paradee-8M: the fast HQ voice. One voice (Kokoro's `af_heart` distilled into 8.07M
// parameters), one 9 MB int8 ONNX file, CPU only. Measured here: 0.34x real time on a
// single WASM thread, 0.22x with four — Kokoro-82M (92 MB int8) sits near or above 1.0x.
//
// The model is downloaded once, from a commit-pinned Hugging Face URL, checksum-verified,
// and kept in Cache Storage. Nothing else about it needs the network: page text is
// phonemized and synthesized entirely on the device.
//
// The graph takes misaki phoneme ids, not text (see src/shared/paradee-text.js for why),
// so this file owns three things: the download/cache, the ORT session, and the text->audio
// run that returns the audio *plus* the character map playback needs for highlighting.

import * as ort from 'onnxruntime-web/wasm'
import { phonemize } from 'phonemizer'

import { download } from './paradee-download.js'
import { trimEdges } from '../shared/pcm.js'
import { planWindows, words, wordWeights, speedFor } from '../shared/paradee-text.js'
import CONFIG from '../shared/paradee-config.json'

export const PARADEE_ID = 'paradee-8m-v1.0'

// Pinned to a commit, not to "main": the checksum below is only meaningful for one
// revision, and an unpinned URL would otherwise fail silently when upstream commits.
const REPO = 'sahilmahendrakar/Paradee-8M-v1.0'
const REVISION = 'c7f83f86c04e84d0ae94cbe1aad7618e0544f80a'
const MODEL_FILE = 'onnx/paradee_int8.onnx'
const MODEL_SHA256 = '60e8f8a1bc7c546488154e9d99ecac6e9c50baf3f4b684c5b0de48ea03b698eb'
const MODEL_BYTES = 9037971

export const MODEL_URL = `https://huggingface.co/${REPO}/resolve/${REVISION}/${MODEL_FILE}`
export const MODEL_BYTES_MIN = 1e6
export const CACHE_NAME = 'hearline-hq-paradee'

/** eSpeak tag for G2P only; Paradee is American English, whatever the page language is. */
export const G2P_LANG = 'en-us'

/** Threads / speed policy lives with the pure text code so it can be unit-tested. */
export { SPEED_MIN, SPEED_MAX, speedFor } from '../shared/paradee-text.js'

const progressHandlers = new Set()
let session = null
let sessionThreads = 0
let loading = null

export const modelLoaded = () => !!session

function notify(p) { for (const h of progressHandlers) h(p) }

async function sha256(buf) {
  const sum = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(sum)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function openCache() {
  if (!('caches' in self)) throw new Error('storage-unavailable')
  return caches.open(CACHE_NAME)
}

export async function isInstalled() {
  try {
    const cache = await openCache()
    const hit = await cache.match(MODEL_URL)
    return !!(hit && hit.ok)
  } catch (e) {
    return false
  }
}

/** Download + verify + store. onMsg receives { t, pct, label, message }. */
export async function install(onMsg) {
  onMsg({ t: 'install-progress', pct: 1, label: 'Starting download' })
  try {
    const buf = await download({
      fetchImpl: fetch,
      url: MODEL_URL,
      knownBytes: MODEL_BYTES,
      onProgress: (p) => onMsg({ t: 'install-progress', ...p }),
    })
    if (buf.byteLength < MODEL_BYTES_MIN) throw new Error('the downloaded file is truncated')

    onMsg({ t: 'install-progress', pct: 88, label: 'Verifying checksum' })
    const sum = await sha256(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    if (sum !== MODEL_SHA256) {
      throw new Error(`checksum mismatch (expected ${MODEL_SHA256.slice(0, 12)}…, got ${sum.slice(0, 12)}…) — the file was not installed`)
    }

    onMsg({ t: 'install-progress', pct: 92, label: 'Saving to offline storage' })
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist()
    } catch (e) { /* not fatal: Chrome may still evict under pressure */ }
    const cache = await openCache()
    await cache.put(MODEL_URL, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }))

    onMsg({ t: 'install-progress', pct: 95, label: 'Loading the model' })
    await generate('Hello there.', { speed: 1 }) // pays ORT optimisation + eSpeak init
    onMsg({ t: 'install-done', rtf: lastRtf() })
  } catch (e) {
    onMsg({ t: 'install-error', message: String((e && e.message) || e) })
  }
}

export async function removeModel() {
  await releaseSession()
  try { await caches.delete(CACHE_NAME) } catch (e) { /* nothing to delete */ }
}

export async function releaseSession() {
  const s = session
  session = null
  loading = null
  try { if (s && s.release) await s.release() } catch (e) { /* already gone */ }
}

/** Threads only help when the page is cross-origin isolated (SharedArrayBuffer). */
export function usableThreads(requested) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1
  const cap = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1
  return Math.max(1, Math.min(cap, Number(requested) || 1))
}

export async function loadModel({ threads = 1 } = {}) {
  if (session && sessionThreads === usableThreads(threads)) return session
  if (loading) return loading
  loading = (async () => {
    const cache = await openCache()
    const hit = await cache.match(MODEL_URL)
    if (!hit) throw new Error('paradee-not-installed')
    const buf = await hit.arrayBuffer()

    // CPU (wasm) build only: skips the WebGPU variant, and the paths resolve relative to
    // the bundle (dist/offscreen/*.js), so they work inside a worker too.
    ort.env.wasm.wasmPaths = {
      mjs: new URL('../ort/ort-wasm-simd-threaded.mjs', import.meta.url).href,
      wasm: new URL('../ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
    }
    ort.env.wasm.proxy = false
    const n = usableThreads(threads)
    ort.env.wasm.numThreads = n
    const created = await ort.InferenceSession.create(buf, {
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3, // errors only: the C++ warnings would spam the offscreen console
    })
    const previous = session
    session = created
    sessionThreads = n
    if (previous && previous.release) previous.release().catch(() => {})
    return created
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

/**
 * Synthesize one chunk.
 *
 * Returns the PCM plus what playback needs to put the highlight on the right word:
 * `windows` (character range + sample count per ONNX run, in play order) and `weights`
 * (phonemes per word). `speed` is Paradee's own tempo input — using it instead of
 * playbackRate keeps the voice natural, and it changes the audio, so the caller must
 * keep it in its cache key.
 */
export async function generate(text, { speed = 1, threads = 1, signal } = {}) {
  await loadModel({ threads })
  const started = performance.now()
  const plan = await planWindows(text, CONFIG.vocab, phonemize, G2P_LANG)
  if (!plan.windows.length) throw new Error('nothing to say')

  const s = speedFor(speed)
  const runs = []
  for (const w of plan.windows) {
    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(w.ids.map((n) => BigInt(n))), [1, w.ids.length]),
      speed: new ort.Tensor('float32', new Float32Array([s]), [1]),
    }
    const outs = await session.run(feeds)
    const out = outs[session.outputNames && session.outputNames[0] ? session.outputNames[0] : 'waveform']
    if (!out || !out.data) throw new Error('the model returned no audio')
    const wave = Float32Array.from(out.data)
    // One non-finite sample would otherwise poison the whole buffer downstream.
    for (let i = 0; i < wave.length; i++) if (!Number.isFinite(wave[i])) wave[i] = 0
    // Each ONNX run is a separate model call, so each one arrives with its own silence at
    // both ends — trim per run, which also keeps the character map aligned with the audio.
    runs.push({ wave: trimEdges(wave, CONFIG.sample_rate), charStart: w.charStart, charEnd: w.charEnd })
  }

  let total = 0
  for (const r of runs) total += r.wave.length
  const samples = new Float32Array(total)
  let at = 0
  for (const r of runs) { samples.set(r.wave, at); at += r.wave.length }

  const list = words(text)
  const weights = list.length <= 120 ? await wordWeights(list, phonemize, G2P_LANG, text) : []
  lastRun = { ms: performance.now() - started, audio: total / CONFIG.sample_rate }

  return {
    samples,
    sr: CONFIG.sample_rate,
    speed: s,
    phonemes: plan.phonemes,
    dropped: plan.dropped,
    windows: runs.map((r) => ({ charStart: r.charStart, charEnd: r.charEnd, samples: r.wave.length })),
    weights,
  }
}

let lastRun = null
export const lastRtf = () => (lastRun && lastRun.audio > 0 ? lastRun.ms / 1000 / lastRun.audio : null)

/** Seconds of generation per second of speech, measured on a fixed sentence. */
export async function benchmark({ threads = 1 } = {}) {
  const text = 'The quick brown fox jumps over the lazy dog, and then it takes a short rest.'
  const t0 = performance.now()
  const out = await generate(text, { speed: 1, threads })
  const seconds = (performance.now() - t0) / 1000
  const audio = out.samples.length / out.sr
  return { seconds: +seconds.toFixed(3), audio: +audio.toFixed(3), rtf: +(seconds / audio).toFixed(3) }
}
