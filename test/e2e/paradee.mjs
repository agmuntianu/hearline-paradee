// Optional, needs network on first run (~9 MB): installs the fast HQ voice in a real
// browser, then reads a page with it and checks the highlight follows the character
// offsets the model reports. Run: node test/e2e/paradee.mjs
import * as e2e from './env.mjs'
import fs from 'node:fs'
import path from 'node:path'

const extDir = e2e.extCopy({ hostPermissions: ['http://127.0.0.1/*'] })
const { server, url } = await e2e.articleServer()
const ctx = await e2e.launch({ extDir, autoplay: true })
const offline = !process.env.HL_NO_STUB && fs.existsSync(e2e.MODEL_FIXTURE)
if (offline) {
  e2e.stubModelDownload(ctx)
  console.log('      the pinned model is served from test/e2e/fixtures (no network needed)')
} else {
  console.log('      installing over the real network (HL_NO_STUB=1)')
}let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failed++ }
const t0 = Date.now()
const since = () => `${Math.round((Date.now() - t0) / 1000)}s`

try {
  const sw = await e2e.workerOf(ctx)
  const id = e2e.extIdOf(ctx)
  const errors = []
  ctx.on('page', (p) => {
    if (!p.url().includes('offscreen')) return
    p.on('console', (m) => { if (m.type() === 'error') errors.push('offscreen console: ' + m.text().slice(0, 300)) })
    p.on('pageerror', (e) => errors.push('offscreen: ' + String(e).slice(0, 300)))
  })

  // ---- install from the options page -------------------------------------
  const opt = await ctx.newPage()
  opt.on('pageerror', (e) => errors.push('options: ' + (e.stack || e)))
  opt.on('console', (m) => { if (m.type() === 'error') errors.push('options console: ' + m.text().slice(0, 300)) })
  await opt.goto(`chrome-extension://${id}/options/options.html#voices`)
  await opt.waitForFunction(() => /Not installed|✓ Installed/.test(document.getElementById('fast-status').textContent), null, { timeout: 15000 })
  check('fast voice status renders', true, await opt.locator('#fast-status').textContent())
  check('more-voices block is independent and uninstalled', /Not installed/.test(await opt.locator('#more-status').textContent()))

  if (!/✓ Installed/.test(await opt.locator('#fast-status').textContent())) {
    await opt.click('#fast-install')
    let last = ''
    const deadline = Date.now() + 6 * 60 * 1000
    while (Date.now() < deadline) {
      const status = await opt.locator('#fast-status').textContent()
      const label = (await opt.locator('#fast-progress .label').textContent().catch(() => '')) || ''
      if (label !== last) { console.log(`      [${since()}] ${label}`); last = label }
      if (/✓ Installed|failed/i.test(status)) { console.log(`      [${since()}] ${status}`); break }
      await opt.waitForTimeout(1000)
    }
  }
  const installed = /✓ Installed/.test(await opt.locator('#fast-status').textContent())
  check('model installed, checksum verified', installed, await opt.locator('#fast-status').textContent())
  if (!installed) throw new Error('install failed: ' + errors.join(' | '))

  // The speed test runs by itself right after an install.
  await opt.waitForFunction(() => /real time|failed/.test(document.getElementById('fast-bench-out').textContent), null, { timeout: 180000 })
  const bench = await opt.locator('#fast-bench-out').textContent()
  console.log(`      [${since()}] ${bench}`)
  check('speed test ran after install', /real time/.test(bench))

  const s = await e2e.readSettings(opt)
  check('install saved under settings.hq.paradee', s.hq.paradee.installed === true, JSON.stringify(s.hq.paradee))
  check('speed test saved an rtf and a thread count', s.hq.paradee.rtf != null && s.hq.paradee.threads >= 1, JSON.stringify(s.hq.paradee))
  check('fast enough to be the default voice', s.hq.paradee.rtf < 1.1, `rtf=${s.hq.paradee.rtf}`)
  check('kokoro untouched by the paradee install', s.hq.kokoro.installed === false)

  // ---- read a page with it -------------------------------------------------
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('page: ' + e))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('page console: ' + m.text().slice(0, 300)) })
  await page.goto(url)
  await page.bringToFront()
  const res = await sw.evaluate(async (id) => run(id, 'readPage'), await e2e.tabIdOf(sw, url))
  check('reader opened', res && res.ok, JSON.stringify(res))

  const label = await page.locator('#hearline-root >> .vlabel').textContent()
  check('fast voice chosen by default', /Heart \(fast\)/.test(label), label)
  await e2e.pressPlay(page) // opening shows the controls; speech starts on play

  // Record the highlighted words in order: the character offsets from the model must land
  // on real word boundaries and walk forwards through the sentence.
  await page.evaluate(() => {
    window.__words = []
    window.__poll = setInterval(() => {
      const set = CSS.highlights.get('hl-word')
      if (!set || !set.size) return
      const r = set.values().next().value
      const t = (r ? r.toString() : '').trim()
      if (t && t !== window.__words[window.__words.length - 1]) window.__words.push(t)
    }, 120)
  })

  let count = '0'
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000)
    count = await page.locator('#hearline-root >> .count').textContent()
    if (parseInt(count) >= 3) break
  }
  const words = await page.evaluate(() => { clearInterval(window.__poll); return window.__words })
  check('word highlight driven by model character offsets', words.length > 8, `${words.length} words: ${words.slice(0, 8).join(' ')}`)
  check('advanced to the next sentences after the audio ended', parseInt(count) >= 3, count)

  const clean = words.filter((w) => /^[\p{L}\p{N}’'-]+$/u.test(w))
  check('highlight lands on word boundaries, not mid-word', clean.length >= words.length - 2, `${words.length - clean.length} odd: ${words.filter((w) => !clean.includes(w)).slice(0, 5).join('|')}`)

  // The offsets must walk the page's own words in order — a broken character map shows up
  // here as words out of sequence or skipped.
  const pageWords = (fs.readFileSync(path.join(e2e.root, 'test', 'e2e', 'article.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .match(/[\p{L}\p{N}’'-]+/gu) || []).slice(0, 80)
  let matched = 0
  for (const w of pageWords) if ((words[matched] || '').toLowerCase() === w.toLowerCase()) matched++
  check('highlight walks the page words in order', matched >= 10 && matched >= words.length - 3, `matched ${matched} of ${words.length}: ${words.slice(0, 12).join(' ')}`)

  // Speed change mid-sentence: the next chunk must be synthesized at the new tempo.
  await page.locator('#hearline-root >> [data-a="speed"]').click()
  await page.locator('#hearline-root >> .presets button[data-v="2"]').click()
  const t1 = Date.now()
  let moved = false
  for (let i = 0; i < 25 && !moved; i++) {
    await page.waitForTimeout(1000)
    moved = parseInt(await page.locator('#hearline-root >> .count').textContent()) > parseInt(count)
  }
  check('keeps reading at 2x (model speed + playbackRate)', moved, `${Math.round((Date.now() - t1) / 1000)}s`)

  // Export the page as a wav (the menu item only exists when an HQ voice is in play). The
  // offscreen document starts the download, which playwright does not report as an event,
  // so the toast is what proves it ran end to end.
  await page.locator('#hearline-root >> [data-a="menu"]').click()
  await page.getByText('Download page as audio', { exact: false }).click()
  let toast = ''
  for (let i = 0; i < 40 && !/saved|failed/i.test(toast); i++) {
    await page.waitForTimeout(1000)
    toast = await page.locator('#hearline-root >> .toast').textContent().catch(() => '')
  }
  check('exports the page as a wav file', /saved to your downloads/i.test(toast), toast || 'no export toast')

  await page.keyboard.press('Escape')
  console.log(`\nerrors: ${errors.length ? errors.join('\n  ') : 'none'}`)
  if (errors.length) failed++
} catch (e) {
  console.error('ERROR', e)
  failed++
} finally {
  await ctx.close()
  server.close()
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
