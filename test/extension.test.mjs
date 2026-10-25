// Contract tests for the parts that are invisible to unit and browser tests: what the
// toolbar button does, and that the permission set never creeps up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'src/manifest.json'), 'utf8'))
const background = readFileSync(path.join(root, 'src/background.js'), 'utf8')
const content = readFileSync(path.join(root, 'src/content/index.js'), 'utf8')

test('the toolbar button opens the controls instead of a popup', () => {
  assert.equal(manifest.action.default_popup, undefined, 'no popup on the action')
  assert.match(manifest.action.default_title, /Read this page/, 'the tooltip says what the click does')
  assert.match(background, /chrome\.action\.onClicked\.addListener/, 'the worker handles the click')
  assert.match(background, /run\(tab\.id, 'toggle'\)/, 'and it toggles the reader on that tab')
})

test('the reader opens paused: nothing reads by itself', () => {
  const opens = content.match(/HL\.reader\.open\(\{[^}]*\}\)/g) || []
  assert.equal(opens.length, 3, 'the open paths are found')
  const pageOpens = opens.filter((c) => !c.includes('selection'))
  assert.equal(pageOpens.length, 2, 'the two page-open paths')
  for (const call of pageOpens) assert.match(call, /autoplay: false/, `${call} must not start speech`)
  assert.ok(opens.some((c) => /selection: true/.test(c)), 'reading a selection is still an explicit "read this now"')
})

test('permissions stay what the README promises', () => {
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'contextMenus', 'offscreen'])
  assert.equal(manifest.host_permissions, undefined)
  assert.equal(manifest.content_scripts, undefined, 'no always-on content script')
  assert.ok(!/"<all_urls>"/.test(JSON.stringify(manifest)))
})

test('every content file the worker injects exists on disk', () => {
  const list = background.match(/const CONTENT_FILES = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''))
  for (const f of list) assert.ok(readFileSync(path.join(root, 'src', f), 'utf8').length > 0, f)
  assert.ok(list.indexOf('content/reader.js') < list.indexOf('content/index.js'), 'reader.js is defined before index.js uses it')
})
