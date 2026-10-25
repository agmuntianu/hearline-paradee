// Real-browser smoke test: loads dist/ in Chromium and drives the content script.
import * as e2e from './env.mjs'

const { server, url } = await e2e.articleServer()
const extDir = e2e.extCopy({ hostPermissions: ['http://127.0.0.1/*'] })
const ctx = await e2e.launch({ extDir })
let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failed++ }

try {
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }))
  check('service worker started', !!sw)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url)
  await page.bringToFront()
  const before = await page.evaluate(() => document.body.innerHTML)

  // Inject + open the reader (selection-free) through the background worker, like the popup does.
  const res = await sw.evaluate(async (id) => run(id, 'readPage'), await e2e.tabIdOf(sw, url))
  check('background injected content scripts', res && res.ok, JSON.stringify(res))
  await page.waitForSelector('#hearline-root', { state: 'attached', timeout: 8000 })
  check('player host attached', true)

  const count = await page.locator('#hearline-root >> .count').textContent()
  console.log('      progress label:', count)
  const total = parseInt(count.split('/')[1])
  check('sentences extracted (nav/footer/code skipped)', total >= 9 && total <= 14, `total=${total}`)

  const play0 = await page.locator('#hearline-root >> [data-a="toggle"]').getAttribute('aria-label')
  check('opening shows the controls and waits for play', play0 === 'Play', play0)

  // "Read from here": the button must survive the trip from the paragraph to the gutter.
  const para = page.locator('p').filter({ hasText: 'Solar panels convert sunlight' }).first()
  const pbox = await para.boundingBox()
  await page.mouse.move(pbox.x + 30, pbox.y + 5)
  await page.waitForTimeout(300)
  const hv = page.locator('#hearline-root >> .hover')
  check('a play button appears beside the paragraph', await hv.isVisible())
  const hbox = await hv.boundingBox()
  await page.mouse.move(hbox.x + hbox.width / 2, hbox.y - 16) // on the way there, off the paragraph
  await page.waitForTimeout(300)
  check('it stays up while the pointer reaches for it', await hv.isVisible())
  await page.mouse.click(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2)
  await page.waitForTimeout(500)
  const cAfterHover = await page.locator('#hearline-root >> .count').textContent()
  check('clicking it reads from that paragraph', !cAfterHover.trim().startsWith('1 /'), cAfterHover)

  const after = await page.evaluate(() => document.body.innerHTML)
  check('page body not mutated (only shadow host added)', after.replace(/<div id="hearline-root"><\/div>/, '') === before)

  // Controls
  const c0 = await page.locator('#hearline-root >> .count').textContent()
  await page.locator('#hearline-root >> [data-a="next"]').click()
  const c2 = await page.locator('#hearline-root >> .count').textContent()
  check('next sentence moves position', parseInt(c2) === parseInt(c0) + 1, `${c0.trim()} -> ${c2.trim()}`)
  await page.locator('#hearline-root >> [data-a="nextPara"]').click()
  const c3 = await page.locator('#hearline-root >> .count').textContent()
  console.log('      after next paragraph:', c3)

  // Speed + voice popovers
  await page.locator('#hearline-root >> [data-a="speed"]').click()
  check('speed popover opens', await page.locator('#hearline-root >> .speedval').isVisible())
  await page.locator('#hearline-root >> .presets button[data-v="1.5"]').click()
  const lbl = await page.locator('#hearline-root >> .speedlbl').textContent()
  check('speed preset applies', lbl === '1.5×', lbl)
  await page.locator('#hearline-root >> [data-a="voice"]').click()
  check('voice popover opens', await page.locator('#hearline-root >> .pop').isVisible())
  const popText = await page.locator('#hearline-root >> .pop').innerText()
  console.log('      voice popover:', popText.replace(/\n+/g, ' | ').slice(0, 200))
  check('voice popover offers HQ install or voices', /HQ voice|System voices|No system voices/i.test(popText))
  await page.keyboard.press('Escape')

  // Summary
  await page.locator('#hearline-root >> [data-a="menu"]').click()
  await page.getByText('Summary of this page', { exact: false }).click()
  await page.waitForSelector('#hearline-root >> .side')
  const items = await page.locator('#hearline-root >> .side .item').count()
  check('summary lists sentences', items >= 3, `items=${items}`)
  const sideBox = await page.locator('#hearline-root >> .side').boundingBox()
  check('the summary panel is styled (the component CSS parsed)', sideBox && sideBox.width < 500, JSON.stringify(sideBox))
  await page.locator('#hearline-root >> .side header button').click()

  // RSVP
  await page.locator('#hearline-root >> [data-a="menu"]').click()
  await page.getByText('Speed reading', { exact: false }).click()
  await page.waitForSelector('#hearline-root >> .rsvp')
  const w1 = (await page.locator('#hearline-root >> .stage').innerText()).replace(/\s+/g, '')
  await page.waitForTimeout(900)
  const w2 = (await page.locator('#hearline-root >> .stage').innerText()).replace(/\s+/g, '')
  check('RSVP advances words', w1 !== w2, `${w1} -> ${w2}`)
  await page.keyboard.press('Escape')
  check('RSVP closes with Escape', (await page.locator('#hearline-root >> .rsvp').count()) === 0)

  // Highlight on the page when a sentence is current
  const hlCount = await page.evaluate(() => 'highlights' in CSS)
  check('CSS Highlight API available', hlCount)

  // Escape closes the player
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('Escape closes the player', (await page.locator('#hearline-root').count()) === 0)

  // Second open works (idempotent)
  await sw.evaluate(async (id) => run(id, 'toggle'), await e2e.tabIdOf(sw, url))
  await page.waitForSelector('#hearline-root', { state: 'attached' })
  check('toggle reopens player', true)
  const roots = await page.locator('#hearline-root').count()
  check('only one player host', roots === 1)

  // The exact path a user takes: close with the X, then start reading again.
  await page.locator('#hearline-root >> [data-a="close"]').click()
  await page.waitForTimeout(400)
  check('the X button closes the player', (await page.locator('#hearline-root').count()) === 0)
  await sw.evaluate(async (id) => run(id, 'readPage'), await e2e.tabIdOf(sw, url))
  await page.waitForSelector('#hearline-root >> .bar', { state: 'visible', timeout: 8000 })
  check('reading again after the X shows the controls again', await page.locator('#hearline-root >> .bar').isVisible())
  const barBox = await page.locator('#hearline-root >> .bar').boundingBox()
  const barPe = await page.locator('#hearline-root >> .bar').evaluate((el) => getComputedStyle(el).pointerEvents)
  check('the reopened player is styled and clickable', barBox && barBox.width < 800 && barBox.height > 60 && barPe === 'auto', `${JSON.stringify(barBox)} pointer-events:${barPe}`)

  // Options page loads
  const opt = await ctx.newPage()
  const extId = new URL(sw.url()).host
  await opt.goto(`chrome-extension://${extId}/options/options.html#welcome`)
  await opt.waitForSelector('#fast-status')
  await opt.waitForFunction(() => /Not installed|Installed/.test(document.getElementById('fast-status').textContent), null, { timeout: 8000 })
  check('options page renders HQ status', true, await opt.locator('#fast-status').textContent())

  // Popup page loads
  const pop = await ctx.newPage()
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`)
  await pop.waitForSelector('#read-page, #msg:not([hidden])')
  check('popup renders', true)
  // The popup blocks in this harness (its own tab is the "active" tab), so check the voice
  // rules it depends on are actually loaded there instead of driving the list.
  const hqOk = await pop.evaluate(() => {
    const s = { hq: { paradee: { installed: true, rtf: 0.3, threads: 0 }, kokoro: { installed: false, rtf: null } } }
    return { api: typeof HL.hq.pick, voices: HL.hq.voices('paradee').length, pick: HL.hq.pick(s, { saved: null, lang: 'en' }) }
  })
  check('popup has the HQ voice rules loaded', hqOk.api === 'function' && hqOk.voices === 1 && hqOk.pick && hqOk.pick.engine === 'paradee', JSON.stringify(hqOk))

  console.log('\nconsole/page errors:', errors.length ? errors : 'none')
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
