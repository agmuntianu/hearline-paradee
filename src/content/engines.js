(function (root) {
  const HL = (root.__HL = root.__HL || {})

  /**
   * Engine interface:
   *   speak(text, { engine, voice, rate, lang, threads }, { onWord(charIndex), onEnd(), onError(err), onStatus(s) })
   *   pause() resume() cancel() setRate(rate) prefetch(texts, opts) warm(engine, threads)
   * onWord receives a character index into the text given to speak().
   * `engine` is 'web' | 'paradee' | 'kokoro'; the two HQ ones are spoken by the offscreen document.
   */

  function WebEngine() {
    const synth = window.speechSynthesis
    let current = null // { utter, text, opts, cb, lastIdx, token }
    let token = 0
    let restartOnResume = false

    function start(from) {
      const c = current
      const myToken = c.token
      const utter = new SpeechSynthesisUtterance(c.text.slice(from))
      if (c.opts.voice) utter.voice = c.opts.voice
      utter.lang = (c.opts.voice && c.opts.voice.lang) || c.opts.lang || 'en-US'
      utter.rate = c.opts.rate || 1
      utter.onboundary = (e) => {
        if (myToken !== token) return
        if (e.name && e.name !== 'word') return
        c.lastIdx = from + e.charIndex
        c.cb.onWord && c.cb.onWord(c.lastIdx)
      }
      utter.onend = () => { if (myToken === token) c.cb.onEnd && c.cb.onEnd() }
      utter.onerror = (e) => {
        if (myToken !== token) return
        if (e.error === 'canceled' || e.error === 'interrupted') return
        c.cb.onError && c.cb.onError(e.error || 'speech-error')
      }
      c.utter = utter
      synth.speak(utter)
    }

    function speak(text, opts, cb) {
      token++
      synth.cancel()
      current = { text, opts, cb, lastIdx: 0, token }
      restartOnResume = false
      const t = token
      // Chrome can drop a speak() issued in the same tick as cancel().
      setTimeout(() => { if (t === token) start(0) }, 40)
    }

    return {
      id: 'web',
      speak,
      pause() {
        if (!current) return
        if (current.opts.voice && current.opts.voice.localService === false) {
          // Network voices do not pause reliably: stop and restart from the last word.
          restartOnResume = true
          token++
          current.token = token
          synth.cancel()
        } else {
          synth.pause()
        }
      },
      resume() {
        if (!current) return
        if (restartOnResume) {
          restartOnResume = false
          start(current.lastIdx)
        } else {
          synth.resume()
        }
      },
      cancel() {
        token++
        current = null
        restartOnResume = false
        synth.cancel()
      },
      setRate(rate) {
        if (!current) return
        current.opts = Object.assign({}, current.opts, { rate })
        token++
        current.token = token
        synth.cancel()
        const from = current.lastIdx
        const t = token
        setTimeout(() => { if (t === token && current) start(from) }, 40)
      },
      prefetch() {},
    }
  }

  /**
   * Talks to the offscreen document that runs the HQ voices (Paradee, Kokoro) and plays
   * the audio. One port serves both engines; each request carries `engine`.
   */
  function HqEngine({ onMedia }) {
    let port = null
    let connecting = null
    let seq = 0
    let cur = null // { id, text, cb, lastWord }

    async function connect() {
      if (port) return port
      if (connecting) return connecting
      connecting = (async () => {
        const res = await chrome.runtime.sendMessage({ type: 'ensure-offscreen' })
        if (!res || !res.ok) throw new Error('offscreen-unavailable')
        const p = chrome.runtime.connect({ name: 'hearline-hq' })
        p.onMessage.addListener(onMessage)
        p.onDisconnect.addListener(() => {
          port = null
          if (cur) { const c = cur; cur = null; c.cb.onError && c.cb.onError('disconnected') }
        })
        port = p
        return p
      })()
      try { return await connecting } finally { connecting = null }
    }

    function onMessage(msg) {
      if (msg.t === 'media') { onMedia && onMedia(msg.action); return }
      if (!cur || msg.id !== cur.id) return
      const c = cur
      if (msg.t === 'loading') c.cb.onStatus && c.cb.onStatus('loading')
      else if (msg.t === 'start') c.cb.onStatus && c.cb.onStatus('playing')
      else if (msg.t === 'progress') {
        // HQ tells us the character the voice is at (from phoneme weights). Without that
        // map — the Kokoro path — fall back to the fraction of the audio played.
        const pos = msg.char != null ? msg.char : Math.floor(msg.p * c.text.length)
        const idx = wordStartAt(c.text, pos)
        if (idx !== c.lastWord) { c.lastWord = idx; c.cb.onWord && c.cb.onWord(idx) }
      } else if (msg.t === 'end') { cur = null; c.cb.onEnd && c.cb.onEnd() }
      else if (msg.t === 'error') { cur = null; c.cb.onError && c.cb.onError(msg.message || 'hq-error') }
    }

    function wordStartAt(text, pos) {
      const w = HL.text.wordAt(text, Math.min(pos, Math.max(0, text.length - 1)))
      return w.start
    }

    const send = (msg) => { if (port) port.postMessage(msg) }

    return {
      id: 'hq',
      async speak(text, opts, cb) {
        const id = ++seq
        cur = { id, text, cb, lastWord: -1 }
        try {
          const p = await connect()
          if (!cur || cur.id !== id) return
          p.postMessage({
            t: 'speak', id, text, voice: opts.voice, rate: opts.rate, title: opts.title,
            backend: opts.engine || 'paradee', threads: opts.threads || 0,
          })
        } catch (e) {
          if (cur && cur.id === id) { cur = null; cb.onError && cb.onError(String(e.message || e)) }
        }
      },
      /** Load the model and speak one word in the background, so the first real sentence is fast. */
      async warm(engine, threads) {
        try {
          const p = await connect()
          p.postMessage({ t: 'warm', backend: engine, threads })
        } catch (e) { /* no offscreen yet: the first speak will pay for it */ }
      },
      pause() { send({ t: 'pause' }) },
      resume() { send({ t: 'resume' }) },
      cancel() { cur = null; send({ t: 'cancel' }) },
      setRate(rate) { send({ t: 'rate', rate }) },
      prefetch(texts, opts) { if (port) send({ t: 'prefetch', texts, voice: opts.voice, backend: opts.engine, rate: opts.rate, threads: opts.threads || 0 }) },
      async exportAudio(texts, opts) {
        const p = await connect()
        p.postMessage({ t: 'export', texts, voice: opts.voice, title: opts.title, backend: opts.engine, rate: opts.rate })
        return p
      },
      get port() { return port },
    }
  }

  const api = { WebEngine, HqEngine }
  HL.engines = api
  if (typeof module !== 'undefined') module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
