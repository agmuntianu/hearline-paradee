// Unit tests for the pure Paradee text side: G2P mapping, vocabulary ids, prosody
// segmentation, window planning and the audio->word timing map.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { phonemize } from 'phonemizer'

import {
  MAX_PHONEMES, PROSODY, toMisaki, splitProsody, phonemesToIds, cutPhonemes,
  planWindows, words, wordWeights, makeTimingMap,
} from '../src/shared/paradee-text.js'

const CFG = JSON.parse(readFileSync(new URL('../src/shared/paradee-config.json', import.meta.url), 'utf8'))


test('toMisaki rewrites eSpeak spelling into the one Paradee was trained on', () => {
  assert.equal(toMisaki(['həlˈoʊ', 'wˈɜːld']), 'həlˈO wˈɜɹld')
  assert.equal(toMisaki('aɪ aʊ ɔɪ eɪ oʊ'), 'I W Y A O')
  assert.equal(toMisaki('dʒ tʃ ɾ ʔ ɚ'), 'ʤ ʧ T t əɹ')
  assert.equal(toMisaki('θɜːɹɪt ˈwɔːɾɚ'), 'θɜɹɪt ˈwɔTəɹ', 'flap t becomes T, ɚ becomes əɹ')
  assert.ok(!toMisaki('ɪt kˈɔst').includes('ː'), 'length marks are dropped')
  assert.equal(toMisaki('nˈeɪvəl ˈɒfɪsɚ'), 'nˈAvᵊl ˈɒfɪsəɹ', 'syllabic l; upstream leaves ɒ alone')
  assert.equal(toMisaki(''), '', 'empty in, empty out')
})

test('toMisaki accepts the array phonemize() returns and joins its lines', () => {
  assert.equal(toMisaki(['dˈɑːktəɹ', 'smˈɪθ']), 'dˈɑktəɹ smˈɪθ')
  assert.equal(toMisaki(['a', '', 'b']), 'a b', 'blank IPA lines are skipped')
})

test('splitProsody keeps punctuation aside as prosody and reports exact offsets', () => {
  const parts = splitProsody('Hello, world! Second part')
  assert.deepEqual(parts.map((p) => [p.segment, p.prosody]), [['Hello', ','], ['world', '!'], ['Second part', '']])
  for (const p of parts) assert.equal('Hello, world! Second part'.slice(p.start, p.end), p.segment)
})

test('splitProsody walks lines and never loses a character', () => {
  const text = 'One line.\nAnother, here — and “quoted” words…\n\nTrailing'
  assert.deepEqual(splitProsody(text).map((p) => [p.segment, p.prosody]), [
    // Quotes stay inside the segment; the blank line adds a longer pause (';').
    ['One line', '.'], ['Another', ','], ['here', '—'], ['and “quoted” words', '…;'], ['Trailing', ''],
  ])
  for (const p of splitProsody(text)) assert.equal(text.slice(p.start, p.end), p.segment)
  for (const mark of PROSODY) assert.ok(CFG.vocab[mark] !== undefined, `vocab has an id for ${mark}`)
})

test('splitProsody folds punctuation that the G2P drops into the prosody tail', () => {
  assert.deepEqual(splitProsody('“Hello.” She asked?').map((p) => [p.segment, p.prosody]), [
    ['“Hello', '.”'], ['She asked', '?'],
  ])
  assert.deepEqual(splitProsody('Wait?! What (now) next').map((p) => [p.segment, p.prosody]), [
    ['Wait', '?!'], ['What (now) next', ''],
  ])
})

test('splitProsody survives junk input', () => {
  assert.deepEqual(splitProsody(''), [])
  assert.deepEqual(splitProsody(null), [])
  assert.deepEqual(splitProsody('   '), [])
  assert.deepEqual(splitProsody('...'), [], 'punctuation alone speaks nothing')
})

test('phonemesToIds pads both ends, drops out-of-vocab characters, and stays inside 512', () => {
  const { ids, dropped } = phonemesToIds('həˈloʊ 🎉 wˈɜːld', CFG.vocab)
  assert.equal(ids[0], 0)
  assert.equal(ids[ids.length - 1], 0)
  assert.deepEqual(dropped, [' ', '🎉'].filter((c) => CFG.vocab[c] === undefined))
  const big = phonemesToIds('a'.repeat(MAX_PHONEMES + 40), CFG.vocab)
  assert.equal(big.ids.length, MAX_PHONEMES + 2, 'two pads on top of the window')
  assert.ok(big.ids.every((n) => n >= 0 && n < CFG.n_token))
})

test('cutPhonemes cuts at a word boundary, never inside a word', () => {
  const ps = 'ɪt kˈɔst dˈɑləɹ wˈʌn θˈWzənd tˈuhˈʌndɹɪd'
  const { head, rest } = cutPhonemes(ps, 14)
  assert.equal(head, 'ɪt kˈɔst', 'cuts at the last space that fits')
  assert.equal(head + ' ' + rest, ps)
  assert.equal(cutPhonemes(ps, 1000).rest, '')
})

// A fake G2P: letters only, and with the script-g that English eSpeak emits (the vocab
// has no ASCII 'g', so a naive stub would look like the pipeline is dropping things).
const fakeG2P = (text) => async (t) => [t.toLowerCase().replace(/[^\w ]/g, ' ').replace(/g/g, 'ɡ')]

test('planWindows runs one window per chunk and stays under the 512-position graph', async () => {
  const text = 'The quick brown fox jumps over the lazy dog, and then it takes a short rest.'
  const { windows, phonemes, dropped } = await planWindows(text, CFG.vocab, fakeG2P(text))
  assert.equal(windows.length, 2, 'the comma splits it into two prosodic segments')
  assert.deepEqual(windows.map((w) => w.ids[0]), [0, 0])
  assert.ok(phonemes > 0 && dropped.length === 0)
  assert.ok(windows.every((w) => w.ids.length <= CFG.n_token))
  assert.equal(windows[0].charStart, 0)
  assert.ok(windows[0].charEnd <= windows[1].charStart, 'windows advance forward')
  // The trailing period belongs to prosody, not to a segment, so the last window ends
  // right after "rest".
  assert.equal(windows[windows.length - 1].charEnd, text.lastIndexOf('rest') + 4)
})

test('planWindows splits a long segment across windows and keeps the char ranges contiguous', async () => {
  const text = 'alpha '.repeat(160).trim()
  const { windows } = await planWindows(text, CFG.vocab, fakeG2P(text))
  assert.ok(windows.length >= 2, `expected a split, got ${windows.length}`)
  assert.ok(windows.every((w) => w.ids.length <= MAX_PHONEMES + 2))
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i].charStart, windows[i - 1].charEnd)
  assert.equal(windows[0].charStart, 0)
  assert.equal(windows[windows.length - 1].charEnd, text.length)
})

test('planWindows ignores a segment the phonemizer chokes on instead of failing', async () => {
  const boom = async (t) => { if (t.includes('bad')) throw new Error('g2p blew up'); return ['bæd ok'] }
  const { windows } = await planWindows('bad part, ok part', CFG.vocab, boom)
  assert.equal(windows.length, 1)
})

test('the real eSpeak G2P produces in-vocabulary phonemes for ordinary English', async () => {
  const samples = [
    'Reading is faster than listening, but this sounds nicer.',
    'It cost $1,234.99 in 2026 — about 12% more than last year.',
    'Dr. Smith arrived at 3 p.m., and the naval officer bowed.',
    "I can’t believe it’s already November: can you believe it's Tuesday?",
  ]
  for (const text of samples) {
    const { windows, dropped } = await planWindows(text, CFG.vocab, phonemize)
    assert.deepEqual(dropped, [], `nothing dropped for: ${text}`)
    assert.ok(windows.length >= 1 && windows[0].ids.length > 2)
  }
})

test('words() finds words with apostrophes, hyphens and digits', () => {
  const text = "Don't stop — 12-item list, 2026!"
  assert.deepEqual(words(text).map((w) => text.slice(w.start, w.end)), ["Don't", 'stop', '12-item', 'list', '2026'])
})

test('wordWeights counts phonemes per word and caches repeats', async () => {
  let calls = 0
  const counting = async (t) => { calls++; return ['x'.repeat(t.length)] }
  const list = words('one two one')
  const w = await wordWeights(list, counting, 'en-us', 'one two one')
  assert.deepEqual(w.map((x) => x.phonemes), [3, 3, 3])
  assert.equal(calls, 2, 'the repeated word came from cache')
})

test('makeTimingMap weights time by phonemes, not characters', () => {
  // "extraordinary" (13 phonemes) then "fine" (4 phonemes): the second word must not
  // start at 13/17 of the audio.
  const at = makeTimingMap([{ charStart: 0, charEnd: 18, samples: 1000 }], [
    { start: 0, end: 13, phonemes: 13 },
    { start: 14, end: 18, phonemes: 4 },
  ])
  assert.equal(at(0), 0)
  assert.ok(at(0.75) >= 13 && at(0.75) <= 14, `second word starts near its real time, got ${at(0.75)}`)
  assert.equal(at(1), 18)
  let prev = -1
  for (let f = 0; f <= 1.0001; f += 0.01) {
    const c = at(f)
    assert.ok(c >= prev, `monotonic at f=${f.toFixed(2)}: ${c} < ${prev}`)
    prev = c
  }
})

test('makeTimingMap respects per-window audio lengths and falls back to linear', () => {
  const at = makeTimingMap([
    { charStart: 0, charEnd: 10, samples: 100 },
    { charStart: 10, charEnd: 20, samples: 900 },
  ], [{ start: 1, end: 9, phonemes: 8 }])
  assert.ok(at(0.05) < 10, 'the short first window is over early')
  assert.ok(at(0.5) > 10, 'most of the audio belongs to the second window')

  const linear = makeTimingMap([{ charStart: 0, charEnd: 100, samples: 500 }], [])
  assert.equal(linear(0.5), 50, 'no weights means linear')
  assert.equal(makeTimingMap([], []) (0.3), 0, 'no audio at all is not a crash')
})
