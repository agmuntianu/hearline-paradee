// The model download has to survive a connection that dies halfway, because on some
// machines Hugging Face resets long transfers and such a user could otherwise never
// install. The fake fetch below scripts exactly that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { download } from '../src/offscreen/paradee-download.js'

const FILE = Uint8Array.from(Array.from({ length: 1000 }, (_, i) => i % 251))
const slice = (from, to) => FILE.slice(from, to === undefined ? FILE.length : to)

function respond(bytes, { status = 200, contentRange } = {}) {
  return {
    ok: status < 400,
    status,
    headers: new Headers(contentRange
      ? { 'content-range': contentRange, 'content-length': String(bytes.length) }
      : { 'content-length': String(bytes.length) }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: {
      getReader() {
        let at = 0
        return {
          read: async () => {
            if (at >= bytes.length) return { done: true, value: undefined }
            const n = Math.min(100, bytes.length - at)
            const chunk = bytes.slice(at, at + n)
            at += n
            return { done: false, value: chunk }
          },
        }
      },
    },
  }
}

/** Serves `ranges` in order: each entry is a [from, to] to hand out, or an Error to throw. */
function flaky(ranges) {
  const seen = []
  const fetchImpl = async (url, opts) => {
    const header = (opts.headers || {}).range
    seen.push(header || null)
    const step = ranges.shift()
    if (step instanceof Error) throw step
    if (!step) throw new Error('the fake server ran out of scripted responses')
    const [from, to] = step
    const part = slice(from, to)
    if (from === 0 && to === undefined) return respond(part)
    return respond(part, { status: 206, contentRange: `bytes ${from}-${to - 1}/${FILE.length}` })
  }
  return { fetchImpl, seen }
}

test('a reset halfway is resumed with a Range header and the bytes still line up', async () => {
  const { fetchImpl, seen } = flaky([
    [0, 400], // dies at 400 bytes
    new Error('connection reset'),
    [400, 1000],
  ])
  const out = await download({ fetchImpl, url: 'https://x/model.onnx', knownBytes: FILE.length, sleepImpl: async () => {} })
  assert.equal(out.length, FILE.length)
  assert.deepEqual(Array.from(out), Array.from(FILE))
  assert.equal(seen[0], null, 'the first attempt asks for the whole file')
  assert.equal(seen[1], 'bytes=400-', 'the retry asks for the remainder')
})

test('a host that ignores Range restarts the transfer instead of corrupting it', async () => {
  let n = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) return respond(slice(0, 300)) // truncated 200
    return respond(FILE) // full file, no Range honoured
  }
  const out = await download({ fetchImpl, url: 'u', knownBytes: FILE.length, sleepImpl: async () => {} })
  assert.equal(out.length, FILE.length)
  assert.deepEqual(Array.from(out), Array.from(FILE))
})

test('a body that ends early is retried until it is complete', async () => {
  const { fetchImpl } = flaky([[0, 500], [500, 1000]])
  const out = await download({ fetchImpl, url: 'u', knownBytes: FILE.length, sleepImpl: async () => {} })
  assert.deepEqual(Array.from(out), Array.from(FILE))
})

test('a missing file is fatal: one attempt, clear message', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) } }
  await assert.rejects(() => download({ fetchImpl, url: 'u', sleepImpl: async () => {} }), /not at its pinned address/)
  assert.equal(calls, 1)
})

test('gives up after the last attempt and reports the failure', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('socket hang up') }
  await assert.rejects(() => download({ fetchImpl, url: 'u', attempts: 3, sleepImpl: async () => {} }), /socket hang up/)
  assert.equal(calls, 3)
})

test('progress never goes backwards and stays under the install phase', async () => {
  const marks = []
  const { fetchImpl } = flaky([[0, 300], new Error('reset'), [300, 1000]])
  await download({ fetchImpl, url: 'u', knownBytes: FILE.length, sleepImpl: async () => {}, onProgress: (m) => marks.push(m.pct) })
  const last = Math.max(...marks)
  assert.ok(last <= 85, `progress left room for the checksum and cache phases (max ${last})`)
  assert.ok(marks.every((p, i) => i === 0 || p >= marks[i - 1]), 'pct is monotonic')
})
