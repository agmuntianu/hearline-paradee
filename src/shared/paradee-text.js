// Pure text side of the Paradee-8M runtime (https://github.com/sahilmahendrakar/paradee).
//
// Paradee is Kokoro's `af_heart` voice distilled into 8.07M parameters: one 9 MB int8
// ONNX file, one voice, 24 kHz out. Its graph is tiny but picky about its input:
//   input_ids int64 [1, T]  — misaki phoneme ids, id 0 pads both ends, T <= 512
//   speed     float32 [1]
//   waveform  float32 [1, N]
//
// So the whole job is getting text into the right phoneme ids. Paradee was trained on
// misaki (Kokoro's own G2P), NOT on eSpeak NG, and the two spell the same sounds
// differently ("aɪ" vs "I", length marks, flaps). Feeding raw eSpeak phonemes gives
// mush (Paradee's own report: Whisper WER 31% vs 3%), hence `toMisaki()` below, which
// is vendored from the upstream `web/misaki.js` (Apache-2.0).
//
// No DOM, no ONNX, no npm imports: it is unit-tested in test/paradee-text.test.mjs and
// shared by the offscreen worker and the options-page installer (both bundled), and by
// the Node test runner. The G2P itself is injected as an argument so tests can stub it.

/** Text side has 512 positions; two of them are the `0` pads at each end. */
export const MAX_PHONEMES = 510

/** Punctuation Paradee's vocabulary has ids for — these carry the prosody. */
export const PROSODY = ';:,.!?—…()“”"'

/** eSpeak NG IPA -> misaki spelling. Order matters: digraphs before their parts. */
export const E2M = [
  ['ʔˌn̩', 'ʔn'], ['ʔn̩', 'ʔn'], ['aɪ', 'I'], ['aʊ', 'W'], ['dʒ', 'ʤ'], ['eɪ', 'A'], ['e', 'A'],
  ['tʃ', 'ʧ'], ['ɔɪ', 'Y'], ['ʲo', 'jo'], ['ʲə', 'jə'], ['ʲ', ''], ['ɚ', 'əɹ'], ['r', 'ɹ'],
  ['x', 'k'], ['ç', 'k'], ['ɬ', 'l'], ['̃', ''],
]

/** Marks that end a spoken segment (and are re-inserted as prosody ids). */
const STRONG = new Set(';,.!?—…:')
/** Marks that stay inside the segment but vanish in the G2P: fold them into prosody. */
const PASSIVE = new Set('“”"(){}[]·-–')
const WORD_RE = /[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*/uy

/** Join a phonemize() result (array of IPA lines) into one misaki phoneme string. */
export function toMisaki(ipa) {
  let ps = Array.isArray(ipa) ? ipa.filter((s) => s && String(s).trim()).join(' ') : String(ipa || '')
  for (const [a, b] of E2M) ps = ps.split(a).join(b)
  ps = ps.replace(/(\S)̩/gu, 'ᵊ$1').replace(/̩/g, '')
  // misaki writes a syllabic l at the end of a word as ᵊl (naval -> nˈAvᵊl).
  ps = ps.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, 'ᵊl')
  // misaki's table maps ɐ to ə, but its lexicon keeps ɐ for the article "a".
  ps = ps.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, 'ə')
  ps = ps.split('oʊ').join('O').split('ɜːɹ').join('ɜɹ').split('ɜː').join('ɜɹ')
    .split('ɪə').join('iə').split('ː').join('')
  ps = ps.split('o').join('ɔ')
  return ps.split('ɾ').join('T').split('ʔ').join('t')
}

/**
 * Cut text into the segments the model runs on, keeping the punctuation that follows
 * each one. eSpeak-based phonemizers drop punctuation, but Paradee has ids for it and
 * that is what makes a question rise and a comma pause, so the marks ride along.
 *
 * Returns [{ segment, prosody, start, end }] where start/end are offsets into `text`
 * and always trim to `text.slice(start, end) === segment` — that invariant is what
 * turns playback time back into page words.
 */
export function splitProsody(text) {
  const s = String(text == null ? '' : text)
  const out = []
  const n = s.length
  let i = 0
  while (i < n) {
    let gap = ''
    while (i < n && /\s/.test(s[i])) gap += s[i++]
    if (i >= n) break
    let j = i
    while (j < n && !STRONG.has(s[j])) j++
    let end = j
    while (end > i && (/\s/.test(s[end - 1]) || PASSIVE.has(s[end - 1]))) end--
    let prosody = s.slice(end, j).replace(/\s+/g, '')
    let k = j
    while (k < n && STRONG.has(s[k])) prosody += s[k++]
    // A closing quote right after the mark belongs to this segment, not to the next one.
    while (k < n && PASSIVE.has(s[k])) prosody += s[k++]
    // A blank line is a paragraph break: ask for a longer pause than a comma.
    if (gap.split('\n').length > 2 && out.length) out[out.length - 1].prosody += ';'
    const segment = s.slice(i, end)
    if (/[\p{L}\p{N}]/u.test(segment)) out.push({ segment, prosody, start: i, end })
    else if (out.length && prosody) out[out.length - 1].prosody += prosody
    i = k
  }
  return out
}

/** Map misaki phonemes to vocabulary ids, dropping anything out of vocabulary. */
export function phonemesToIds(phonemes, vocab) {
  const ids = []
  const dropped = []
  for (const c of String(phonemes || '')) {
    const id = vocab ? vocab[c] : undefined
    if (id === undefined) {
      if (!dropped.includes(c)) dropped.push(c)
      continue
    }
    ids.push(id)
    if (ids.length >= MAX_PHONEMES) break
  }
  return { ids: [0, ...ids, 0], dropped } // `0` pad at each end
}

/** Cut a phoneme string at the last space that fits the window (never mid-word). */
export function cutPhonemes(phonemes, max = MAX_PHONEMES) {
  const ps = String(phonemes || '')
  if (ps.length <= max) return { head: ps, rest: '' }
  let cut = ps.lastIndexOf(' ', max)
  if (cut <= 0) cut = max
  return { head: ps.slice(0, cut), rest: ps.slice(cut).trimStart() }
}

/**
 * Plan the ONNX runs for one piece of text.
 *
 * @param text        the chunk to speak
 * @param vocab       Paradee config.json vocab (char -> id)
 * @param phonemize   async (text, lang) => string[] of IPA lines (injected: `phonemizer`
 *                    npm in the extension, a stub in tests)
 * @param lang        eSpeak language tag; Paradee is American English only
 * @returns { windows: [{ ids, charStart, charEnd, phonemes, dropped }], phonemes, dropped }
 *
 * `windows` is what the model runs, in order; each carries the character range it covers
 * so playback progress can be mapped back to the page's words.
 */
export async function planWindows(text, vocab, phonemize, lang = 'en-us') {
  const windows = []
  const dropped = []
  let phonemes = 0
  for (const { segment, prosody, start, end } of splitProsody(text)) {
    let ps = ''
    try {
      ps = toMisaki(await phonemize(segment, lang))
    } catch (e) {
      // A G2P hiccup on one segment must not kill the whole chunk.
      continue
    }
    // A cut splits the phonemes; the character boundary follows the share of the
    // phonemes the head consumed, so each window still knows what it covers.
    let at = start
    let remaining = ps
    for (;;) {
      const { head, rest } = cutPhonemes(remaining)
      if (!head.trim()) break
      const body = head + (prosody && !rest ? prosody : '')
      const { ids, dropped: d } = phonemesToIds(body, vocab)
      for (const c of d) if (!dropped.includes(c)) dropped.push(c)
      const share = head.length / Math.max(1, remaining.length)
      const to = rest ? Math.min(end - 1, Math.round(at + (end - at) * share)) : end
      const stop = Math.max(at + 1, to)
      windows.push({ ids, charStart: at, charEnd: stop, phonemes: ids.length, dropped: d })
      at = stop
      phonemes += ids.length
      if (!rest) break
      remaining = rest
    }
  }
  return { windows, phonemes, dropped }
}

/**
 * Paradee's own `speed` input keeps the voice natural only over a modest band; past it the
 * voice slurs. Hearline offers 0.5x-4x, so the remainder is left to playbackRate.
 */
export const SPEED_MIN = 0.7
export const SPEED_MAX = 1.5

export function speedFor(rate) {
  const r = Number(rate)
  return Number.isFinite(r) && r > 0 ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, r)) : 1
}

/** Words in `text` as [{ start, end }] — the same shape HL.text.wordAt works with. */
export function words(text) {
  const out = []
  const re = new RegExp(WORD_RE.source, 'uy')
  const s = String(text == null ? '' : text)
  let i = 0
  while (i < s.length) {
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) { i++; continue } // sticky + a gap = no match: step over the gap and retry
    out.push({ start: m.index, end: m.index + m[0].length })
    i = m.index + m[0].length
  }
  return out
}

/**
 * Phoneme count per word (timing weights only — the audio always comes from the
 * whole-segment phonemes, so this may differ slightly and that is fine).
 */
export async function wordWeights(list, phonemize, lang = 'en-us', text = '') {
  const cache = wordWeights.cache || (wordWeights.cache = new Map())
  const out = []
  for (const w of list) {
    const key = `${lang}|${w.word || text.slice(w.start, w.end)}`
    let n = cache.get(key)
    if (n === undefined) {
      try {
        n = toMisaki(await phonemize(w.word || text.slice(w.start, w.end), lang)).replace(/\s/g, '').length
      } catch (e) {
        n = 0
      }
      if (cache.size > 4000) cache.clear()
      cache.set(key, n)
    }
    out.push({ start: w.start, end: w.end, phonemes: n })
  }
  return out
}

/**
 * Build the audio-progress -> character-index function for one utterance.
 *
 * @param windows  [{ charStart, charEnd, samples }] in play order
 * @param weights  [{ start, end, phonemes }] word weights covering the same text
 *
 * Audio time is proportional to phonemes, not to characters ("beautiful" takes far
 * longer than "fine"), so a linear char map drifts badly inside a long sentence.
 */
export function makeTimingMap(windows, weights) {
  const total = windows.reduce((n, w) => n + (w.samples || 0), 0)
  if (!(total > 0)) return () => 0

  const byWindow = windows.map((w) => {
    const own = (weights || []).filter((x) => x.start >= w.charStart && x.start < w.charEnd)
    const sum = own.reduce((n, x) => n + (x.phonemes || 0), 0)
    return { w, own, sum }
  })

  let cum = 0
  return function charAtProgress(f) {
    const p = Math.max(0, Math.min(1, f || 0))
    const target = p * total
    let pick = byWindow[byWindow.length - 1]
    let base = 0
    cum = 0
    for (const entry of byWindow) {
      const span = entry.w.samples || 0
      if (target <= cum + span || entry === byWindow[byWindow.length - 1]) { pick = entry; base = cum; break }
      cum += span
    }
    const span = pick.w.samples || 1
    const local = Math.max(0, Math.min(1, (target - base) / span))

    if (!(pick.sum > 0)) {
      // No usable weights (numbers, symbols, a stub G2P): fall back to linear.
      return Math.round(pick.w.charStart + local * (pick.w.charEnd - pick.w.charStart))
    }
    let want = local * pick.sum
    let acc = 0
    for (const x of pick.own) {
      const weight = x.phonemes || 0
      if (want <= acc + weight) {
        const inside = weight > 0 ? (want - acc) / weight : 0
        return Math.round(x.start + inside * (x.end - x.start))
      }
      acc += weight
    }
    return pick.w.charEnd
  }
}
