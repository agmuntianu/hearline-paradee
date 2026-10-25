// Tests for the resumable model download: a scripted fetch that drops mid-transfer,
// ignores Range, 404s, or stops early. These are the paths that decide whether a user on a
// flaky connection can install the voice at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { download } from '../src/offscreen/paradee-download.js'

const SIZE = 9000
const WHOLE = Uint8Array.from({ length: SIZE }, (_, i) => i % 251)
const slice = (from, to) => WHOLE.slice(from, to)

function response(body, { status = 200, contentLength = SIZE, contentRange = null } = {}) {
  const headers = new Headers()
  if (contentLength != null) headers.set('content-length', String(contentLength))
  if (contentRange) headers.set('content-range', contentRange)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: {
      getReader() {
        let at = 0
        return {
          read: async () => {
            if (at >= body.length) return { done: true }
            const take = Math.min(1000, body.length - at)
            const value = body.slice(at, at + take)
            at += take
            return { done: false, value }
          },
        }
      },
    },
    arrayBuffer: async () => body.slice().buffer,
  }
}

/** A fetch that breaks the stream after `breakAfter` bytes on the first `breaks` attempts. */
function flakyFetch({ breaks = 1, breakAfter = 3000, rangeAware = true, log = [] }) {
  let n = 0
  const fetchImpl = async (url, opts) => {
    n++
    log.push({ n, range: (opts.headers || {}).range || null })
    const from = rangeAware && opts.headers && opts.headers.range ? Number(/bytes=(\d+)-/.exec(opts.headers.range)[1]) : 0
    if (n <= breaks) {
      const head = slice(from, from + breakAfter)
      return {
        ...response(head, { contentLength: SIZE }),
        body: {
          getReader() {
            let at = 0
            return {
              read: async () => {
                if (at >= head.length) return Promise.reject(new Error('socket reset'))
                const take = Math.min(1000, head.length - at)
                const value = head.slice(at, at + take)
                at += take
                return { done: false, value }
              },
            }
          },
        },
      }
    }
    if (from > 0) return response(slice(from, SIZE), { status: 206, contentLength: SIZE - from, contentRange: `bytes ${from}-${SIZE - 1}/${SIZE}` })
    return response(slice(from, SIZE))
  }
  fetchImpl.log = log
  return fetchImpl
}

const run = (fetchImpl, extra = {}) => {
  const waits = []
  const labels = []
  const p = download(Object.assign({
    fetchImpl,
    url: 'https://example.test/model.onnx',
    knownBytes: SIZE,
    sleepImpl: (ms) => { waits.push(ms); return Promise.resolve() },
    onProgress: (p2) => labels.push(p2.label),
  }, extra))
  return { p, waits, labels, log: fetchImpl.log || [] }
}

test('a clean transfer takes one attempt and returns the exact bytes', async () => {
  const calls = []
  const { p } = run(async (url, opts) => { calls.push(opts.headers || {}); return response(WHOLE) })
  const buf = await p
  assert.deepEqual(buf, WHOLE)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].range, undefined, 'no Range header on a fresh download')
})

test('a connection that drops mid-file resumes with a Range header', async () => {
  const { p, labels, log: attempts } = run(flakyFetch({ breaks: 1, breakAfter: 3000 }))
  const buf = await p
  assert.deepEqual(buf, WHOLE, 'the bytes from both attempts are stitched together')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[1].range, 'bytes=3000-', 'the retry asks for the remainder, not the whole file')
  assert.match(labels.join('|'), /resuming at 33%/)
})

test('a host that ignores Range starts over instead of corrupting the file', async () => {
  const { p, log: attempts } = run(flakyFetch({ breaks: 1, breakAfter: 2000, rangeAware: false }))
  const buf = await p
  assert.deepEqual(buf, WHOLE)
  assert.equal(attempts[1].range, 'bytes=2000-')
  // The 200 response replaces the partial file, so the result is exactly SIZE bytes.
  assert.equal(buf.length, SIZE)
})

test('a body that ends early without an error is treated as incomplete', async () => {
  let n = 0
  const log = []
  const { p } = run(async (url, opts) => {
    n++
    log.push({ n, range: (opts.headers || {}).range || null })
    if (n === 1) return response(slice(0, 4000), { contentLength: SIZE }) // done: true, but short
    return response(slice(4000, SIZE), { status: 206, contentLength: SIZE - 4000, contentRange: `bytes 4000-${SIZE - 1}/${SIZE}` })
  })
  const buf = await p
  assert.deepEqual(buf, WHOLE)
  assert.equal(log.length, 2)
  assert.equal(log[1].range, 'bytes=4000-')
})

test('a missing file fails at once instead of retrying five times', async () => {
  let n = 0
  const { p, waits } = run(async () => { n++; return response(new Uint8Array(0), { status: 404, contentLength: 0 }) })
  await assert.rejects(p, /not at its pinned address/)
  assert.equal(n, 1)
  assert.equal(waits.length, 0, 'no backoff for an error that will not fix itself')
})

test('gives up after the last attempt and reports the waits', async () => {
  const { p, waits, log: attempts } = run(flakyFetch({ breaks: 99, breakAfter: 500 }))
  await assert.rejects(p, /socket reset/)
  assert.equal(attempts.length, 5, 'attempts defaults to 5')
  assert.deepEqual(waits, [800, 1600, 2400, 3200])
})

test('progress percentages stay inside the install bar', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => response(WHOLE)
  const { p } = { p: download({ fetchImpl, url: 'u', knownBytes: SIZE, sleepImpl: () => Promise.resolve(), onProgress: (x) => seen.push(x.pct) }) }
  await p
  assert.ok(seen.length >= 9)
  assert.ok(seen.every((x) => x >= 0 && x <= 85), seen.join(','))
  assert.ok(seen[seen.length - 1] === 85)
})
