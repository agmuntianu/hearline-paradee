# Changelog

## 1.3.0 — this fork (vibecoded)

Written by an AI coding agent under human direction — see the note at the top of the README. Everything from 1.2.0 down is upstream.
- New: "the fast voice" — Paradee-8M (Kokoro's `af_heart` distilled to 8 million parameters) as a second HQ voice: 9 MB once, around 4x faster than playback on a typical laptop, and it becomes the default HQ voice when its speed test passes
- New: for that voice the highlight follows the model's own character positions (Misaki phoneme offsets mapped back to the page text) instead of an estimate from audio playback time
- New: HQ model downloads resume where they stopped and retry with a backoff (Hugging Face resets long downloads on some connections), and the file is checked against the pinned sha256
- New: real browser tests for both HQ voices, with the models served from `test/e2e/fixtures` so they run without the network
- Changed: HQ voice state lives per engine under `settings.hq.<engine>`; the names, labels and pick rules live in one module used by the player, the popup and Settings
- Changed: Kokoro is offered as "More voices" (28 voices, installed on demand) next to the fast voice
- Changed: the toolbar icon opens the player straight away — the popup is out of the way (voice and speed are in the player, everything else is in Settings)
- Changed: opening a page shows the controls paused; the voice starts when you press play. Reading a selection from the right‑click menu still speaks right away
- Changed: the "read from here" button by a paragraph now stays up while the pointer travels to it — it used to vanish the moment the cursor left the paragraph
- Changed: HQ voices leave far less dead air between sentences. The models pad every chunk with ~300 ms of silence in front and ~480 ms behind (measured); that is trimmed to ~70/150 ms, so a sentence boundary went from ~0.9 s to ~0.2 s
- Fixed: closing the player and starting to read again left the controls invisible — the shadow host was rebuilt without the player's stylesheet, so the bar came back unstyled and unclickable
- Fixed: a reading session that failed part way through starting blocked every later attempt until the page was reloaded
- Fixed: `onnxruntime-web` was imported by the build without being declared as a dependency, so a fresh clone could not build it

## 1.2.0
- New: voice picker (system voices by language) with saved choice per language; no hard-coded voice names
- New: optional offline HQ voices (Kokoro-82M, 28 English voices) installed from Settings, with live voice switching
- New: speed 0.5x–4x, progress bar, sentence/paragraph navigation, keyboard shortcuts, draggable player
- New: read selection (context menu / shortcut), read-from-here hover button, Alt+click to seek
- New: speed reading (RSVP), offline summary, pronunciation dictionary, bookmarks, sleep timer, resume position, listening stats
- New: highlight styles, light/dark themes, accent colour; options page and a real popup
- New: download page as WAV audio (HQ voices)
- Changed: on-demand injection (`activeTab` + `scripting`) instead of an always-on `<all_urls>` content script
- Changed: block/sentence based reading with accurate offsets, Unicode-aware word highlighting; page DOM is no longer modified
- Fixed: Alt+H shortcut, duplicate listeners/buttons on repeated opens, Escape now closes the player, dead voice button, README claims that did not exist

## 1.0.0
- Initial release
