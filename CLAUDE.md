# Hearline

Chrome MV3 extension that reads any webpage aloud with word-level highlighting. Free, no accounts, no analytics, no servers. Roadmap and scope for v1.2: [plan.md](plan.md).

## Rules that must not be broken
- **Privacy:** never send page text to any server. The only network use is the optional one-time HQ voice download from Hugging Face (Paradee 9 MB, Kokoro 92 MB), which the user starts by clicking "Install". No cloud TTS, no API keys, no analytics.
- **Permissions:** keep to `activeTab`, `scripting`, `storage`, `contextMenus`, `offscreen`. No `<all_urls>` content script and no host permissions. Content scripts are injected on demand by the background worker.
- **No remote code (MV3):** all JS and WASM ship inside the extension. Only model weights are downloaded.
- **Never speak on your own:** opening a page only shows the controls. Speech starts from an explicit act (play, `Alt`+click, hover button, read‑selection). The toolbar icon has no popup — it opens the player directly.
- **Do not mutate the host page** beyond the single `#hearline-root` shadow host and an adopted stylesheet for `::highlight()` rules. No injected buttons, no forced `position` on page elements.
- **No hard-coded voice names.** Voices are picked by language, saved choice and quality score (`src/shared/voices.js`).
- The README must only describe features that exist.

## Layout
```
src/                  extension root (what gets built)
  manifest.json
  background.js       injection, commands, context menu, offscreen lifecycle
  shared/             pure modules, unit-tested (settings, text, lang, voices, kokoro-voices, hq)
  content/            injected scripts (extract, engines, summarize, rsvp, player, reader, index)
  popup/  options/    extension pages
  offscreen/          HQ voice host + one inference worker per engine (bundled by esbuild)
test/                 node:test unit tests; test/e2e runs the built extension in Chromium
build.mjs             copies src -> dist, bundles the offscreen workers, copies ORT wasm, optional zip
```
Content and most shared files are plain scripts (no modules). Each attaches to `globalThis.__HL` and also exports via `module.exports` when run under Node so tests can import it. Injection order is the `CONTENT_FILES` list in `src/background.js`; add new files there.

Two shared files are ES modules instead, because esbuild pulls them into the offscreen bundles: `shared/paradee-text.js` (text -> phonemes) and `shared/wav.js` (PCM -> wav). They are copied to `dist/shared` raw and must never be added to `CONTENT_FILES`.

## Commands
- `npm install`
- `npm run build` -> `dist/` (load this folder via chrome://extensions -> Load unpacked)
- `npm test` -> unit tests (includes `test/extension.test.mjs`: manifest shape, toolbar action, no-autoplay contract, permission set)
- `node test/e2e/run.mjs` -> installs `dist/` into headless Chromium and drives a real page
- `node test/e2e/paradee.mjs` / `node test/e2e/kokoro.mjs` -> same, for each HQ voice (models are served from `test/e2e/fixtures`; `HL_NO_STUB=1` forces the real download)
- `npm run package` -> `hearline-<version>.zip`

## Conventions
- Vanilla JS, 2-space indent, single quotes, no semicolons, no frameworks.
- Settings live in `chrome.storage.local` under `settings`; defaults and merge in `src/shared/settings.js`. Wrap every storage call in try/catch.
- Engines implement `speak(text, opts, cb)`, `pause()`, `resume()`, `cancel()`, `setRate()`, `warm(cb)` and `prefetch(text, opts, cb)`; callbacks are `onWord(charIndex)`, `onEnd()`, `onError(err)`. `opts` is `{engine, voice, rate, threads}`.
- HQ speech is generated ahead of playback (`prefetch`) so the model is never on the critical path, and audio is cached in the offscreen document, not in the worker.
- HQ install state lives at `settings.hq.<engine>` (`installed`, `bytes`, `rtf`, `slow`, `threads`, `voices`). Which voice to use is decided only by `shared/hq.js` (`pick` / `usable` / `label`); the same strings are used in the player, popup and options page.
- Text offsets: chunk offsets refer to the original block text; spoken text may be transformed (`transform()` in `text.js`), so always map back with `toOriginal`. Paradee reports character positions in the phonemised string — `misakiPositions()` in `paradee-text.js` maps those back to the text that was spoken.
- Pure logic goes in `shared/` with a test; DOM code stays in `content/`.
- `HL.host` owns every stylesheet in the overlay (`addStyle` + re-applying on rebuild). Component CSS must not be registered once per page, because `close()` destroys the host and a second open would rebuild it unstyled.
- Model edge silence is trimmed in `shared/pcm.js` (`trimEdges`), applied by each engine worker before the audio reaches playback, and by paradee-core per ONNX run so the character map stays aligned.

## Testing notes
- Unit tests cover pure logic only. Everything else is covered by the real browser tests in `test/e2e` (Chromium via `playwright-core`, already a devDependency).
- The Kokoro model download is unreliable on this machine (connections reset). Downloads in `paradee-download.js` are resumable and retry, and the e2e harness serves the models locally instead of the network.
- `misaki/js` upstream breaks its own browser bundle occasionally (it imports `../run` by absolute path). `build.mjs` patches that file out of the bundled copy and the e2e suite re-checks the upstream tarball.
- Reload the extension at chrome://extensions after each `npm run build`.
