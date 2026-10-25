const HL = globalThis.__HL
const $ = (id) => document.getElementById(id)
let settings = null

const fmtRate = (v) => `${(+v).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}×`
const save = async (patch) => { settings = await HL.settings.save(patch); return settings }

function bind() {
  $('rate').value = settings.rate
  $('rate-out').textContent = fmtRate(settings.rate)
  $('rate').addEventListener('input', () => { $('rate-out').textContent = fmtRate($('rate').value); save({ rate: +$('rate').value }) })

  $('wpm').value = settings.rsvpWpm
  $('wpm').addEventListener('change', () => save({ rsvpWpm: Math.max(100, Math.min(1000, +$('wpm').value || 300)) }))

  $('autoScroll').checked = settings.autoScroll
  $('autoScroll').addEventListener('change', () => save({ autoScroll: $('autoScroll').checked }))

  for (const k of ['citations', 'code', 'urls', 'emoji']) {
    const el = $(`skip-${k}`)
    el.checked = settings.skip[k]
    el.addEventListener('change', () => save({ skip: { [k]: el.checked } }))
  }

  for (const k of ['highlight', 'theme']) {
    $(k).value = settings[k]
    $(k).addEventListener('change', () => save({ [k]: $(k).value }))
  }
  $('accent').value = settings.accent
  $('accent').addEventListener('change', () => save({ accent: $('accent').value }))
}

// ---- HQ voices ------------------------------------------------------------------
// Two installs, one widget shape: Paradee (one voice, 9 MB, comfortably real time) and the
// full Kokoro set (28 voices, ~95 MB, needs a fast machine).
const HQ = {
  paradee: { prefix: 'fast' },
  kokoro: { prefix: 'more', some: () => HL.kokoroVoices.INSTALL_DEFAULT, all: () => HL.kokoroVoices.VOICES.map((v) => v.id) },
}

function installer() {
  return new Promise((resolve) => {
    if (window.HLInstaller) return resolve(window.HLInstaller)
    window.addEventListener('hl-installer-ready', () => resolve(window.HLInstaller), { once: true })
  })
}

async function refreshEngine(engine) {
  const p = HQ[engine].prefix
  const inst = await installer()
  const installed = await inst.isInstalled(engine)
  const st = (settings.hq || {})[engine] || {}
  if (installed !== st.installed) settings = await save({ hq: { [engine]: { installed } } })
  const measured = st.rtf == null ? '' : ` Speed test: ${st.rtf.toFixed(2)}× real time.`
  $(`${p}-status`).textContent = installed ? `✓ Installed — works offline.${measured}` : 'Not installed.'
  $(`${p}-install`).hidden = installed
  if ($(`${p}-more`)) $(`${p}-more`).hidden = !installed
  $(`${p}-remove`).hidden = !installed
  $(`${p}-bench`).hidden = !installed
}

async function runInstall(engine, arg, button) {
  const p = HQ[engine].prefix
  const inst = await installer()
  const progress = $(`${p}-progress`)
  button.disabled = true
  progress.hidden = false
  $(`${p}-status`).textContent = 'Installing… keep this tab open.'
  try { await navigator.storage.persist() } catch (e) { /* best effort: keeps the cache from being evicted */ }
  await inst.install(engine, arg, async (m) => {
    if (m.t === 'install-progress') {
      progress.querySelector('.bar').style.width = m.pct + '%'
      progress.querySelector('.label').textContent = `${m.label} · ${m.pct}%`
    } else if (m.t === 'install-done') {
      settings = await save({ hq: { [engine]: { installed: true } } })
      progress.hidden = true
      button.disabled = false
      await refreshEngine(engine)
      $(`${p}-status`).textContent = '✓ Installed — works offline.'
      if (((settings.hq || {})[engine] || {}).rtf == null) {
        const out = $(`${p}-bench-out`)
        out.hidden = false
        try { await runBenchmark(engine, out) } catch (e) { out.textContent = `Speed test failed: ${e.message}` }
      }
    } else if (m.t === 'install-error') {
      progress.hidden = true
      button.disabled = false
      $(`${p}-status`).textContent = `Install failed: ${m.message}. Check your connection and try again.`
    }
  })
}

// Runs the speed test, saves the best result (rtf and the thread count that won), and shows it.
async function runBenchmark(engine, out) {
  const p = HQ[engine].prefix
  const inst = await installer()
  const r = await inst.benchmark(engine, (msg) => { out.textContent = msg })
  const lines = r.results.map((x) => `${x.threads} thread${x.threads > 1 ? 's' : ''}: ${x.seconds.toFixed(1)} s to make ${x.audio.toFixed(1)} s of speech (${x.rtf.toFixed(2)}× real time)`)
  const best = Math.min(...r.results.map((x) => x.rtf))
  const win = r.results.find((x) => x.rtf === best) || r.results[0]
  settings = await save({ hq: { [engine]: { rtf: best, threads: win.threads } } })
  const verdict = best <= 0.8 ? 'Fast enough: this voice is your default.' : best <= 1.1 ? 'Borderline: expect short pauses between sentences.' : 'Too slow on this computer: Hearline keeps your system voice as the default. You can still pick this voice, but expect long pauses.'
  out.textContent = `${lines.join(' · ')} · ${r.cores} CPU cores · isolation ${r.isolated ? 'on' : 'OFF'}. ${verdict}`
  return best
}

async function removeEngine(engine) {
  if (!confirm('Remove this voice? You can install it again later.')) return
  const inst = await installer()
  await inst.removeModel(engine)
  settings = await save({
    hq: { [engine]: { installed: false, rtf: null, threads: 0 } },
    voices: Object.fromEntries(Object.entries(settings.voices).filter(([, v]) => v.engine !== engine)),
  })
  refreshEngine(engine)
}

function bindHq() {
  const wanted = /^#voices(?::(paradee|kokoro))?$/.exec(location.hash)
  for (const engine of Object.keys(HQ)) {
    const p = HQ[engine].prefix
    $(`${p}-install`).addEventListener('click', (e) => runInstall(engine, HQ[engine].some ? HQ[engine].some() : null, e.target))
    if ($(`${p}-more`)) $(`${p}-more`).addEventListener('click', (e) => runInstall(engine, HQ[engine].all(), e.target))
    $(`${p}-remove`).addEventListener('click', () => removeEngine(engine))
    $(`${p}-bench`).addEventListener('click', async (e) => {
      const out = $(`${p}-bench-out`)
      const btn = e.target
      btn.disabled = true
      out.hidden = false
      try { await runBenchmark(engine, out) } catch (err) { out.textContent = `Speed test failed: ${err.message}` }
      btn.disabled = false
    })
    if (wanted && wanted[1] === engine) $(`${p}-install`).classList.add('flash')
    refreshEngine(engine)
  }
}

// ---- pronunciation ---------------------------------------------------------------
function renderPron() {
  const list = $('pron-list')
  list.textContent = ''
  settings.pronunciations.forEach((p, i) => {
    const row = document.createElement('div')
    row.className = 'row'
    const txt = document.createElement('div')
    txt.className = 'txt'
    txt.textContent = `${p.from} → ${p.to || '(skip)'}`
    const del = document.createElement('button')
    del.textContent = 'Remove'
    del.addEventListener('click', async () => {
      await save({ pronunciations: settings.pronunciations.filter((_, k) => k !== i) })
      renderPron()
    })
    row.append(txt, del)
    list.appendChild(row)
  })
}

function bindPron() {
  renderPron()
  $('pron-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const from = $('pron-from').value.trim()
    if (!from) return
    await save({ pronunciations: [...settings.pronunciations, { from, to: $('pron-to').value.trim() }] })
    $('pron-from').value = $('pron-to').value = ''
    renderPron()
  })
}

// ---- bookmarks / stats / data ----------------------------------------------------------
async function renderBookmarks() {
  const { bookmarks = [] } = await chrome.storage.local.get('bookmarks')
  const box = $('bookmarks')
  box.textContent = ''
  if (!bookmarks.length) { box.textContent = 'No bookmarks yet. Use ⋯ → “Bookmark this sentence” in the player.'; return }
  bookmarks.forEach((b, i) => {
    const row = document.createElement('div')
    row.className = 'row'
    const txt = document.createElement('div')
    txt.className = 'txt'
    const a = document.createElement('a')
    a.href = b.url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = b.title || b.url
    const small = document.createElement('small')
    small.textContent = b.text
    txt.append(a, small)
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.addEventListener('click', async () => {
      bookmarks.splice(i, 1)
      await chrome.storage.local.set({ bookmarks })
      renderBookmarks()
    })
    row.append(txt, del)
    box.appendChild(row)
  })
}

async function renderStats() {
  const { stats } = await chrome.storage.local.get('stats')
  const words = (stats && stats.words) || 0
  const mins = Math.round(((stats && stats.seconds) || 0) / 60)
  $('stats').textContent = words ? `${words.toLocaleString()} words read aloud · about ${mins} min of listening.` : 'Nothing yet — start reading a page.'
}

function bindData() {
  $('clear-positions').addEventListener('click', async () => { await chrome.storage.local.remove('positions'); alert('Reading positions cleared.') })
  $('clear-all').addEventListener('click', async () => {
    if (!confirm('Reset all settings, bookmarks, stats and saved positions? HQ voices stay installed.')) return
    const keep = { paradee: settings.hq.paradee, kokoro: settings.hq.kokoro }
    await chrome.storage.local.clear()
    await HL.settings.save({
      hq: {
        paradee: { installed: keep.paradee.installed, rtf: keep.paradee.rtf, threads: keep.paradee.threads },
        kokoro: { installed: keep.kokoro.installed, rtf: keep.kokoro.rtf },
      },
    })
    location.reload()
  })
  renderBookmarks()
  renderStats()
}

;(async () => {
  settings = await HL.settings.load()
  if (location.hash === '#welcome') $('welcome').hidden = false
  if (location.hash.startsWith('#voices')) $('voices').scrollIntoView()
  bind()
  bindHq()
  bindPron()
  bindData()
})()
