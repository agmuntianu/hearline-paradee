// Installs the larger HQ voice set (if needed) and prints the Settings speed-test result.
// Needs network on first run. Run: node test/e2e/bench.mjs
import * as e2e from './env.mjs'

const extDir = e2e.extCopy()
const ctx = await e2e.launch({ extDir, profile: process.env.HL_PROFILE })
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'))
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html`)
  await page.waitForFunction(() => /Not installed|Installed/.test(document.getElementById('more-status').textContent))
  if (!/✓ Installed/.test(await page.locator('#more-status').textContent())) {
    await page.click('#more-install')
    await page.waitForFunction(() => /✓ Installed|failed/.test(document.getElementById('more-status').textContent), null, { timeout: 480000 })
  }
  await page.click('#more-bench')
  await page.waitForFunction(() => /real time|failed/.test(document.getElementById('more-bench-out').textContent), null, { timeout: 240000 })
  console.log(await page.locator('#more-bench-out').textContent())
} finally {
  await ctx.close()
}
