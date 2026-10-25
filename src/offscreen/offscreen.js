// The offscreen document: it hosts the optional HQ voices (Paradee, and Kokoro for people
// who want more than one voice), plays the audio, and reports progress to the page that
// asked. Inference runs in a worker per engine so this document keeps answering messages —
// and so neither engine pays to load the other's runtime.
//
// It also owns the one thing the page cannot know: where the playhead actually is in the
// text. Each engine returns audio plus a character map, so progress arrives as a character
// offset, not a bare percentage.

import { wavBlob } from '../shared/wav.js'
import { makeTimingMap, speedFor } from '../shared/paradee-text.js'

const HOSTS = {
  paradee: { file: 'offscreen/paradee-worker.js', worker: null, pending: new Map() },
  kokoro: { file: 'offscreen/worker.js', worker: null, pending: new Map() },
}
let rpcId = 0

/** The tempo the engine itself renders at; the rest of the rate is playbackRate's job. */
function engineSpeed(backend, rate) {
  return backend === 'paradee' ? speedFor(rate) : 1
}

function getWorker(backend) {
  const h = HOSTS[backend]
  if (!h) throw new Error(`unknown engine: ${backend}`)
  if (h.worker) return h.worker
  const w = new Worker(chrome.runtime.getURL(h.file), { type: 'module' })
  w.onmessage = (e) => {
    const m = e.data
    const p = h.pending.get(m.id)
    if (!p) return
    h.pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error))
    else if (m.cancelled) p.resolve(null)
    else p.resolve(m)
  }
  w.onerror = (e) => {
    const err = new Error(e.message || 'worker-failed')
    for (const p of h.pending.values()) p.reject(err)
    h.pending.clear()
    h.worker = null
  }
  h.worker = w
  return w
}

function generate(backend, { text, voice, speed, threads }) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId
    HOSTS[backend].pending.set(id, { resolve, reject })
    getWorker(backend).postMessage({ id, text, voice, speed, threads })
  })
}

/** Ask an engine's worker to load its model and speak one short line (off the critical path). */
function warm(backend, { threads } = {}) {
  const h = HOSTS[backend]
  if (!h || h.warmed) return
  h.warmed = true
  const id = ++rpcId
  h.pending.set(id, { resolve: () => {}, reject: () => { h.warmed = false } })
  getWorker(backend).postMessage({ id, warm: true, threads })
}

// One generation at a time per engine; stale prefetches are dropped before they run.
const chains = { paradee: Promise.resolve(), kokoro: Promise.resolve() }
function enqueue(backend, fn) {
  const run = chains[backend].then(fn)
  chains[backend] = run.catch(() => {})
  return run
}

// ---- audio cache ---------------------------------------------------------
const cache = new Map() // key -> Promise<{ samples, sr, windows, weights } | null>
let epoch = 0

const keyFor = (backend, voice, speed, text) => `${backend}|${voice}|${speed}|${text}`

function getAudio(backend, voice, speed, text, { prefetch = false, speakId = 0 } = {}) {
  const key = keyFor(backend, voice, speed, text)
  if (cache.has(key)) {
    const hit = cache.get(key)
    cache.delete(key)
    cache.set(key, hit) // refresh LRU position
    return hit
  }
  const myEpoch = epoch
  const p = enqueue(backend, async () => {
    // Superseded by a newer request: skip the expensive work.
    if (prefetch ? myEpoch !== epoch : speakId && current.id !== speakId) { cache.delete(key); return null }
    return generate(backend, { text, voice, speed, threads: current.threads })
  })
  p.catch(() => cache.delete(key))
  cache.set(key, p)
  while (cache.size > 12) cache.delete(cache.keys().next().value)
  return p
}

async function fetchAudio(backend, voice, speed, text, speakId) {
  const first = await getAudio(backend, voice, speed, text, { speakId })
  if (first) return first
  if (speakId && current.id !== speakId) return null // cancelled meanwhile
  return getAudio(backend, voice, speed, text, { speakId }) // a dropped prefetch left a hole: generate for real
}

// ---- playback --------------------------------------------------------------
let playing = null // { port, id, el, url, timer, timing }

function stopPlayback() {
  if (!playing) return
  clearInterval(playing.timer)
  playing.el.onended = playing.el.onerror = null
  playing.el.pause()
  URL.revokeObjectURL(playing.url)
  playing = null
}

function post(port, msg) {
  try { port.postMessage(msg) } catch (e) { /* port closed */ }
}

function setMediaSession(port, title) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'Hearline', artist: 'Hearline' })
  const relay = (action) => () => post(port, { t: 'media', action })
  navigator.mediaSession.setActionHandler('play', relay('play'))
  navigator.mediaSession.setActionHandler('pause', relay('pause'))
  navigator.mediaSession.setActionHandler('nexttrack', relay('next'))
  navigator.mediaSession.setActionHandler('previoustrack', relay('prev'))
}

async function speak(port, msg) {
  const { id, text, voice, rate, title, backend = 'paradee' } = msg
  const speed = engineSpeed(backend, rate)
  epoch++
  stopPlayback()
  try {
    const pending = cache.has(keyFor(backend, voice, speed, text))
    if (!pending) post(port, { t: 'loading', id })
    const audio = await fetchAudio(backend, voice, speed, text, id)
    if (!audio || current.id !== id) return // a newer request arrived while generating
    const url = URL.createObjectURL(wavBlob([audio.samples], audio.sr))
    const el = new Audio(url)
    el.preservesPitch = true
    el.playbackRate = (Number(rate) || 1) / speed // the model already sang it at `speed`
    const state = { port, id, el, url, timer: 0, speed, backend, text }
    // Time is proportional to phonemes, not characters, so the engine's own character map
    // is what keeps the highlight on the word being spoken.
    state.timing = audio.windows && audio.windows.length ? makeTimingMap(audio.windows, audio.weights || []) : null
    playing = state
    el.onended = () => { if (playing === state) { stopPlayback(); post(port, { t: 'end', id }) } }
    el.onerror = () => { if (playing === state) { stopPlayback(); post(port, { t: 'error', id, message: 'audio-playback-failed' }) } }
    await el.play()
    setMediaSession(port, title)
    post(port, { t: 'start', id, dur: el.duration })
    state.timer = setInterval(() => {
      if (el.duration > 0) {
        const p = Math.min(1, el.currentTime / el.duration)
        const m = { t: 'progress', id, p }
        if (state.timing) m.char = state.timing(p)
        post(port, m)
      }
    }, 60)
  } catch (e) {
    if (current.id === id) post(port, { t: 'error', id, message: String((e && e.message) || e) })
  }
}

const current = { id: 0, threads: 0 }

// ---- export ---------------------------------------------------------------
async function exportAudio(port, { texts, voice, title, backend = 'paradee', rate = 1 }) {
  try {
    const parts = []
    let sr = 24000
    const speed = engineSpeed(backend, rate)
    for (let i = 0; i < texts.length; i++) {
      const a = await fetchAudio(backend, voice, speed, texts[i], 0)
      if (!a) break
      sr = a.sr
      parts.push(a.samples, new Float32Array(Math.round(sr * 0.2)))
      post(port, { t: 'export-progress', done: i + 1, total: texts.length })
    }
    const blob = wavBlob(parts, sr)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(title || 'hearline').replace(/[^\p{L}\p{N}\s-]+/gu, '').trim().slice(0, 60) || 'hearline'}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
    post(port, { t: 'export-done' })
  } catch (e) {
    post(port, { t: 'export-error', message: String((e && e.message) || e) })
  }
}

// ---- ports --------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hearline-hq') return
  port.onMessage.addListener((msg) => {
    switch (msg.t) {
      case 'speak':
        current.id = msg.id
        current.threads = msg.threads || 0
        speak(port, msg)
        break
      case 'prefetch':
        current.threads = msg.threads || 0
        for (const text of msg.texts || []) {
          getAudio(msg.backend || 'paradee', msg.voice, engineSpeed(msg.backend || 'paradee', msg.rate), text, { prefetch: true }).catch(() => {})
        }
        break
      case 'warm':
        current.threads = msg.threads || 0
        warm(msg.backend || 'paradee', { threads: msg.threads })
        break
      case 'export':
        exportAudio(port, msg)
        break
      case 'pause':
        if (playing) playing.el.pause()
        break
      case 'resume':
        if (playing) playing.el.play().catch(() => {})
        break
      case 'cancel':
        current.id = 0
        epoch++
        stopPlayback()
        for (const h of Object.values(HOSTS)) if (h.worker) h.worker.postMessage({ cancel: true })
        break
      case 'rate':
        // The chunk already playing was rendered at another tempo: shift it with
        // playbackRate, and let the next chunk be synthesized at the new one.
        if (playing) playing.el.playbackRate = (Number(msg.rate) || 1) / playing.speed
        break
    }
  })
  port.onDisconnect.addListener(() => {
    if (playing && playing.port === port) { current.id = 0; stopPlayback() }
  })
})
