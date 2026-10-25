// Resumable model download, kept separate so the retry logic can be tested with a fake
// fetch. Connections to the model host drop now and then on some machines — a reset in the
// middle of a large transfer, not a 404 — and restarting from byte 0 every time means such
// a user can never finish, so a retry asks for the remainder with a Range header.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Returns the whole file as a Uint8Array, or throws the last failure.
 * `fetchImpl` and `sleepImpl` are injected so tests can script a flaky connection.
 */
export async function download({ fetchImpl, url, knownBytes, attempts = 5, onProgress = () => {}, sleepImpl = sleep }) {
  const parts = []
  let loaded = 0
  let total = knownBytes || 0
  let failure = new Error('download failed')

  const report = (label) => onProgress({
    pct: Math.min(85, Math.round((loaded / Math.max(1, total || knownBytes || 1)) * 85)),
    label,
  })

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { credentials: 'omit', headers: loaded > 0 ? { range: `bytes=${loaded}-` } : {} })
      if (res.status === 404) throw Object.assign(new Error('the model file is not at its pinned address'), { fatal: true })
      if (!res.ok && res.status !== 206) throw new Error(`download failed (HTTP ${res.status})`)

      const ranged = /\/(\d+)$/.exec(res.headers.get('content-range') || '')
      if (ranged) total = +ranged[1]
      else if (!total) total = Number(res.headers.get('content-length')) || 0
      if (loaded > 0 && res.status !== 206) { parts.length = 0; loaded = 0 } // the host ignored Range
      if (loaded === 0) report('Downloading voice model')

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          parts.push(chunk.value)
          loaded += chunk.value.length
          report('Downloading voice model')
        }
      } else {
        const only = new Uint8Array(await res.arrayBuffer())
        parts.length = 0
        parts.push(only)
        loaded = only.length
        report('Downloading voice model')
      }
      if (!total || loaded >= total) { failure = null; break }
      failure = new Error('the connection ended before the file did')
    } catch (e) {
      if (e && e.fatal) throw e
      failure = e instanceof Error ? e : new Error(String(e))
    }

    if (!failure || attempt === attempts) break
    const wait = 800 * attempt
    const where = loaded > 0 && total ? ` — resuming at ${Math.round((loaded / total) * 100)}%` : ''
    report(`Connection dropped${where}, retrying in ${Math.round(wait / 1000)} s (try ${attempt + 1} of ${attempts})`)
    await sleepImpl(wait)
  }

  if (failure) throw failure
  let size = 0
  for (const p of parts) size += p.length
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
