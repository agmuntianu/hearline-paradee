// Optional, needs the model fixture (test/e2e/fixtures) or network: installs the larger
// Kokoro voice set in a real browser and speaks a page with it. Run: node test/e2e/kokoro.mjs
import * as e2e from './env.mjs'
import fs from 'node:fs'
import path from 'node:path'

const { server, url } = await e2e.articleServer()
const extDir = e2e.extCopy({ hostPermissions: ['http://127.0.0.1/*'] })
const ctx = await e2e.launch({ extDir, autoplay: true })
if (!process.env.HL_NO_MIRROR) e2e.mirrorHfFixtures(ctx) // cached under test/e2e/fixtures/hf by node
ctx.on('close', () => console.log('      [ctx closed]'))
let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failed++ }
const t0 = Date.now()
const since = () => `${Math.round((Date.now() - t0) / 1000)}s`

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'))
  const extId = new URL(sw.url()).host
  const opt = await ctx.newPage()
  const errors = []
  opt.on('pageerror', (e) => errors.push('options: ' + e))
  opt.on('console', (m) => { if (m.type() === 'error') errors.push('options console: ' + m.text()) })
  await opt.goto(`chrome-extension://${extId}/options/options.html#voices`)
  await opt.waitForFunction(() => /Not installed|Installed/.test(document.getElementById('more-status').textContent))
  // The model itself is seeded into the extension's model cache from the local server: a
  // 92 MB body cannot be pushed through the devtools protocol, and this is the same cache a
  // returning user reads from offline.
  const MODEL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx'
  if (fs.existsSync(path.join(e2e.root, 'test/e2e/fixtures/hf/huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx'))) {
    console.log('      seeding the model cache:', (await e2e.seedModelCache(opt, { cache: 'transformers-cache', items: [{ url: MODEL, local: url + 'hf/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx' }] })).join(', '))
  } else {
    console.log('      (model fixture missing — the install will need the network)')
  }
  ctx.on('page', (p) => { if (p.url().includes('offscreen')) { p.on('console', (m) => console.log('      [offscreen]', m.text().slice(0, 300))); p.on('pageerror', (e) => console.log('      [offscreen error]', String(e).slice(0, 300))) } })
  if (!/✓ Installed/.test(await opt.locator('#more-status').textContent())) await opt.click('#more-install')
  let last = ''
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    let status = ''
    try { status = await opt.locator('#more-status').textContent() } catch (e) { console.log('      [status lost] ' + String(e.message).slice(0, 90)); break }
    const label = (await opt.locator('#more-progress .label').textContent().catch(() => '')) || ''
    if (label !== last) { console.log(`      [${since()}] ${label}`); last = label }
    if (/✓ Installed/.test(status) || /failed/i.test(status)) { console.log(`      [${since()}] ${status}`); break }
    await opt.waitForTimeout(1500)
  }
  const installed = /✓ Installed/.test(await opt.locator('#more-status').textContent())
  check('model installed from options page', installed)
  if (!installed) throw new Error('install failed; errors: ' + errors.join(' | '))

  const stored = await e2e.readSettings(opt).then((x) => x.hq.kokoro.installed)
  check('installed flag saved', stored === true)

  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('page: ' + e))
  await page.goto(url)
  await page.bringToFront()
  const res = await sw.evaluate(async (id) => run(id, 'readPage'), await e2e.tabIdOf(sw, url))
  check('reader opened', res.ok, JSON.stringify(res))
  await e2e.pressPlay(page) // the bar opens paused now; speech starts when play is pressed
  console.log(`      [${since()}] reading started, waiting for audio + word highlight…`)

  const voiceLabel = await page.locator('#hearline-root >> .vlabel').textContent()
  check('HQ voice chosen by default', /Heart/.test(voiceLabel), voiceLabel)

  let sawWord = false
  let sawNext = false
  for (let i = 0; i < 90 && !(sawWord && sawNext); i++) {
    await page.waitForTimeout(1000)
    sawWord = sawWord || (await page.evaluate(() => CSS.highlights.has('hl-word')))
    const count = await page.locator('#hearline-root >> .count').textContent()
    sawNext = parseInt(count) >= 2
  }
  check('word highlight driven by Kokoro progress', sawWord)
  check('advanced to the next sentence after audio ended', sawNext)

  // switch voice live
  await page.locator('#hearline-root >> [data-a="voice"]').click()
  await page.locator('#hearline-root >> .pop .opt', { hasText: 'George' }).click()
  await page.waitForTimeout(500)
  const label2 = await page.locator('#hearline-root >> .vlabel').textContent()
  check('voice switch works (George)', /George/.test(label2), label2)
  let ok2 = false
  for (let i = 0; i < 100 && !ok2; i++) {
    await page.waitForTimeout(1000)
    ok2 = await page.evaluate(() => CSS.highlights.has('hl-word'))
    if (i % 5 === 0) {
      const toast = await page.locator('#hearline-root >> .toast').textContent()
      const play = await page.locator('#hearline-root >> [data-a="toggle"]').getAttribute('aria-label')
      const busy = await page.locator('#hearline-root >> [data-a="toggle"]').getAttribute('class')
      console.log(`      [${since()}] after switch: toast="${toast}" play="${play}" class="${busy}" count=${await page.locator('#hearline-root >> .count').textContent()} word=${ok2}`)
    }
  }
  check('speaks with newly selected voice (a not-preinstalled voice may need network)', ok2)

  console.log('\nerrors:', errors.length ? errors : 'none')
} catch (e) {
  console.error('ERROR', e)
  failed++
} finally {
  await ctx.close()
  server.close()
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
