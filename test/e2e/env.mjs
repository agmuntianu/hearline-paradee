// Shared setup for the real-browser tests: a Chromium that can load the unpacked extension.
import { chromium } from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `new URL().pathname`: on Windows that yields "/C:/…" and resolve()
// turns it into "C:\C:\…", so every path below died.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CHROME_LAYOUTS = {
  win32: { base: () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright'), exe: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'] },
  default: { base: () => path.join(os.homedir(), '.cache', 'ms-playwright'), exe: ['chrome-linux64/chrome', 'chrome-linux/chrome'] },
}

export function chromePath() {
  if (process.env.CHROME) return process.env.CHROME
  const layout = CHROME_LAYOUTS[process.platform] || CHROME_LAYOUTS.default
  const base = layout.base()
  let dirs = []
  try {
    dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  } catch (e) { /* no playwright cache */ }
  for (const d of dirs) {
    for (const exe of layout.exe) {
      const p = path.join(base, d, exe)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error(`no Chromium found under ${base} — set CHROME=/path/to/chrome`)
}

export async function articleServer() {
  const html = fs.readFileSync(path.join(root, 'test', 'e2e', 'article.html'))
  const fixRoot = path.join(root, 'test', 'e2e', 'fixtures', 'hf')
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p.startsWith('/hf/')) {
      const file = path.join(fixRoot, 'huggingface.co', p.slice(4))
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' })
        return fs.createReadStream(file).pipe(res)
      }
      res.writeHead(404).end('no fixture')
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

// Tests run against a copy of dist/ with a localhost host permission: activeTab cannot be
// granted without a real user gesture.
export function extCopy({ hostPermissions } = {}) {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-ext-'))
  fs.cpSync(path.join(root, 'dist'), extDir, { recursive: true })
  if (hostPermissions) {
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
    manifest.host_permissions = hostPermissions
    fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest))
  }
  return extDir
}

export function launch({ extDir, profile, autoplay = false } = {}) {
  return chromium.launchPersistentContext(profile || fs.mkdtempSync(path.join(os.tmpdir(), 'hl-')), {
    executablePath: chromePath(),
    headless: false, // extensions cannot be loaded headless in the old mode; new mode needs a real browser
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : [])],
  })
}

export async function workerOf(ctx) {
  return ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'))
}

export const extIdOf = (ctx) => new URL(ctx.serviceWorkers()[0].url()).host

/** Opening the reader no longer starts the voice, so tests press play when they want speech. */
export async function pressPlay(page) {
  const b = page.locator('#hearline-root >> [data-a="toggle"]')
  if ((await b.getAttribute('aria-label')) === 'Play') await b.click()
  await page.waitForTimeout(400)
}

// The pinned model file, kept out of git. When it is present the tests serve it locally so
// they do not depend on a 9 MB download from a host that resets big transfers sometimes.
export const MODEL_FIXTURE = process.env.HL_MODEL || path.join(root, 'test', 'e2e', 'fixtures', 'paradee_int8.onnx')

export function stubModelDownload(ctx, onHit = () => {}) {
  const body = fs.readFileSync(MODEL_FIXTURE)
  return ctx.route('**/*paradee_int8.onnx*', (route) => {
    const range = route.request().headers()['range'] || null
    onHit(range)
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)[1])
      return route.fulfill({
        status: 206,
        body: body.slice(from),
        headers: { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}`, 'content-length': String(body.length - from) },
      })
    }
    return route.fulfill({ status: 200, body, headers: { 'content-length': String(body.length) } })
  })
}

/**
 * Serves Hugging Face requests for the tests from test/e2e/fixtures/hf, fetching and caching
 * a file with node the first time it is asked for. Chrome on some machines resets large
 * transfers, so letting the browser download a 21 MB model makes the test fail for reasons
 * that have nothing to do with the extension; node retries and resumes instead.
 */
export function mirrorHfFixtures(ctx, dir = path.join(root, 'test', 'e2e', 'fixtures', 'hf')) {
  fs.mkdirSync(dir, { recursive: true })
  // Big files are not fulfilled over the devtools protocol (a 92 MB body kills the browser);
  // those are seeded into the extension's own cache instead — see seedModelCache.
  const MAX_FULFILL = 8 * 1e6
  return ctx.route(/^https:\/\/huggingface\.co\//, async (route) => {
    const url = route.request().url()
    const file = path.join(dir, url.slice('https://'.length).replace(/[?]/g, '_q').replace(/[#]/g, '_h'))
    if (!fs.existsSync(file)) {
      const body = await downloadWithNode(url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      console.log(`      [fixture] cached ${url.slice('https://huggingface.co/'.length)} (${(body.length / 1e6).toFixed(1)} MB)`)
    }
    if (fs.statSync(file).size > MAX_FULFILL) return route.fallback()
    return route.fulfill({ status: 200, path: file })
  })
}

/**
 * Puts a large model into the cache the extension itself reads, by fetching it from the
 * local test server. This is the offline path a user already exercises: once the bytes are
 * in Cache Storage, the model host is never contacted again for that file.
 */
export async function seedModelCache(page, { cache, items }) {
  return page.evaluate(async ([name, list]) => {
    const c = await caches.open(name)
    const out = []
    for (const it of list) {
      const hit = await c.match(it.url)
      if (hit) { out.push(`${it.url.split('/').pop()}: already cached`); continue }
      const res = await fetch(it.local)
      if (!res.ok) { out.push(`${it.url.split('/').pop()}: local fetch failed ${res.status}`); continue }
      const blob = await res.blob()
      await c.put(it.url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }))
      out.push(`${it.url.split('/').pop()}: ${blob.size} bytes`)
    }
    return out
  }, [cache, items])
}

async function downloadWithNode(url, { rangeStart = 0, attempt = 1 } = {}) {
  const chunks = []
  let loaded = rangeStart
  let failure = null
  try {
    const res = await fetch(url, { headers: loaded > 0 ? { range: `bytes=${loaded}-` } : {} })
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
    const total = (Number(res.headers.get('content-length')) || 0) + (res.status === 206 ? loaded : 0)
    const reader = res.body.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
      loaded += chunk.value.length
    }
    if (total && loaded < total) throw new Error('ended early')
  } catch (e) {
    failure = e
  }
  if (!failure) return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  if (attempt >= 5) throw new Error(`could not fetch ${url}: ${failure.message}`)
  await new Promise((r) => setTimeout(r, 800 * attempt))
  const rest = await downloadWithNode(url, { rangeStart: loaded, attempt: attempt + 1 })
  return Buffer.concat([...chunks.map((c) => Buffer.from(c)), rest])
}

/** The article tab, by URL: a fresh profile opens an extra new-tab page, so "active" is unreliable. */
export function tabIdOf(worker, url) {
  return worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({ url: u + '*' })
    return tabs.length ? tabs[0].id : null
  }, url)
}

/** Reads settings from inside the extension (options page context). */
export const readSettings = (page) => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings)
