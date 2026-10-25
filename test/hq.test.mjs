// Tests for the HQ voice selection rules and for the settings migration that keeps an
// existing Kokoro install working now that Paradee exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('../src/shared/kokoro-voices.js')
const HL = globalThis.__HL
const hq = require('../src/shared/hq.js')
const settings = require('../src/shared/settings.js')

const WITH_PARADEE = { hq: { paradee: { installed: true, rtf: 0.3, threads: 0 }, kokoro: { installed: false, rtf: null } } }
const WITH_BOTH = { hq: { paradee: { installed: true, rtf: 0.3, threads: 0 }, kokoro: { installed: true, rtf: 0.8, threads: 1 } } }
const ONLY_KOKORO = { hq: { paradee: { installed: false, rtf: null, threads: 0 }, kokoro: { installed: true, rtf: 0.8, threads: 1 } } }
const NOTHING = { hq: { paradee: { installed: false, rtf: null, threads: 0 }, kokoro: { installed: false, rtf: null } } }

test('the fast voice wins when it is installed', () => {
  assert.deepEqual(hq.pickDefault(WITH_PARADEE, 'en-US'), { engine: 'paradee', id: 'af_heart' })
  assert.deepEqual(hq.pickDefault(WITH_BOTH, 'en-US'), { engine: 'paradee', id: 'af_heart' })
})

test('a voice slower than speech is skipped, and so is a non-English page', () => {
  const paradeeTooSlow = { hq: { paradee: { installed: true, rtf: 2.5 }, kokoro: { installed: true, rtf: 0.9 } } }
  assert.deepEqual(hq.pickDefault(paradeeTooSlow, 'en-US'), { engine: 'kokoro', id: 'af_heart' })
  // A saved choice is honoured only while it is still usable, slow counts as not usable.
  assert.deepEqual(hq.pick(paradeeTooSlow, { saved: { engine: 'kokoro', id: 'am_michael' }, lang: 'en' }), { engine: 'kokoro', id: 'am_michael' })
  const bothTooSlow = { hq: { paradee: { installed: true, rtf: 2.5 }, kokoro: { installed: true, rtf: 1.4 } } }
  assert.equal(hq.pick(bothTooSlow, { saved: { engine: 'kokoro', id: 'am_michael' }, lang: 'en' }), null)
  assert.deepEqual(hq.pickDefault(WITH_PARADEE, 'fr-FR'), null)
  assert.equal(hq.pickDefault(NOTHING, 'en'), null)
})

test('a saved choice survives only while its engine is still usable', () => {
  assert.deepEqual(hq.pick(WITH_BOTH, { saved: { engine: 'kokoro', id: 'am_michael' }, lang: 'en' }), { engine: 'kokoro', id: 'am_michael' })
  assert.deepEqual(hq.pick(WITH_PARADEE, { saved: { engine: 'kokoro', id: 'am_michael' }, lang: 'en' }), { engine: 'paradee', id: 'af_heart' })
  assert.deepEqual(hq.pick(WITH_PARADEE, { saved: { engine: 'paradee', id: 'af_heart' }, lang: 'en' }), { engine: 'paradee', id: 'af_heart' })
  assert.deepEqual(hq.pick(WITH_PARADEE, { saved: { engine: 'paradee', id: 'nope' }, lang: 'en' }), { engine: 'paradee', id: 'af_heart' })
  assert.deepEqual(hq.pick(ONLY_KOKORO, { saved: { engine: 'web', uri: 'x', name: 'Zira', lang: 'en-US' }, lang: 'en' }), { engine: 'kokoro', id: 'af_heart' })
  assert.equal(hq.pick(NOTHING, { saved: { engine: 'web', uri: 'x', name: 'Zira', lang: 'en-US' }, lang: 'en' }), null)
})

test('British pages get a British Kokoro voice but the one Paradee has', () => {
  assert.deepEqual(hq.pickDefault(ONLY_KOKORO, 'en-GB'), { engine: 'kokoro', id: 'bf_emma' })
  assert.equal(hq.voices('paradee').length, 1, 'Paradee really has a single voice')
  assert.ok(hq.voices('kokoro').length > 20)
})

test('both HQ engines are English-only', () => {
  for (const engine of hq.ORDER) {
    assert.equal(hq.supports(engine, 'de-DE'), false)
    assert.equal(hq.supports(engine, 'en-GB'), true)
    assert.equal(hq.supports(engine, undefined), false)
  }
})

test('an install that has never been speed tested still counts as installed', () => {
  const s = { hq: { paradee: { installed: true, rtf: null }, kokoro: { installed: false } } }
  assert.equal(hq.installed(s, 'paradee'), true)
  assert.equal(hq.slow(s, 'paradee'), false)
  assert.equal(hq.needsBench(s), true)
  assert.equal(hq.needsBench(WITH_PARADEE), false)
})

test('old settings with settings.kokoro migrate into settings.hq.kokoro', () => {
  const old = { rate: 1.5, kokoro: { installed: true, rtf: 1.8 }, voices: { en: { engine: 'kokoro', id: 'af_bella' } } }
  const next = settings.merge(structuredClone(settings.DEFAULTS), settings.migrate(old))
  assert.equal(next.hq.kokoro.installed, true)
  assert.equal(next.hq.kokoro.rtf, 1.8)
  assert.equal(next.hq.paradee.installed, false)
  assert.equal(next.kokoro, undefined, 'the legacy key is gone')
  assert.deepEqual(next.voices.en, { engine: 'kokoro', id: 'af_bella' }, 'saved voices need no migration')
})

test('migrate leaves already-current settings alone', () => {
  const now = { hq: { paradee: { installed: true }, kokoro: { installed: true } } }
  assert.deepEqual(settings.migrate(now), now)
  assert.deepEqual(settings.migrate({ rate: 1 }), { rate: 1 })
  assert.equal(settings.migrate(null), null)
})
