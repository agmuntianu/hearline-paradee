<div align="center">

<img src="src/icons/icon128.png" alt="Hearline logo" width="96" height="96">

# Hearline

**Listen to any webpage.**

Reads articles, blogs and documentation aloud with real-time word highlighting.<br>
Free, private, no account.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-0A7FFF?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/hearline-%E2%80%94-listen-to-any/nnmhcmenlidkfjnhnlmppfkppefeepkb)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-8b5cf6?style=for-the-badge)](CHANGELOG.md)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white)](#tech-stack)

[Features](#features) · [Installation](#installation) · [Usage](#usage) · [HQ voices](#hq-voices) · [Privacy](#privacy) · [Development](#development)

<img width="900" alt="Hearline reading a webpage with word highlighting" src="https://github.com/user-attachments/assets/3d3e4ac4-3e50-44b2-8071-da9b05814c17">

</div>

> ## This fork was vibecoded
>
> The Paradee work below was written by an AI coding agent in a terminal — it read the codebase,
> wrote the ONNX runner, the install path and the tests, and drove a real Chrome to check them.
> A human directed it: chose the feature, listened to every voice sample, and rejected most of
> what came back the first time. Neither of us wrote the models.
>
> What is new here, compared with [upstream Hearline](https://github.com/GroundworkTechnologies/Hearline):
>
> - **A fast offline HQ voice: [Paradee‑8M](https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0)** — 9 MB, one voice, about 4x faster than playback on a laptop CPU. Downloaded at install time, pinned to one Hugging Face revision and checked against a SHA‑256. No weights are committed to this repository.
> - Kokoro became a separate opt‑in (“More voices”); installing one voice set no longer turns the other on.
> - Speech is generated a sentence or two ahead of playback and the models' edge silence is trimmed, so a sentence boundary went from ~0.9 s of dead air to ~0.2 s.
> - The word highlight follows the model's own character positions instead of an estimate from playback time.
> - Clicking the toolbar icon opens the controls instead of a popup; a page never starts reading by itself; the “read from here” button stays under the cursor on pages with indented text.

Everything keeps the upstream MIT license; the two models are Apache‑2.0.

## Overview

Hearline is a free browser extension that reads a webpage aloud while highlighting each word as it is spoken. It is built for students, professionals and anyone who learns better by listening. Open a page, press `Alt+H`, and start listening.

- **Private by design.** No account, no analytics, no servers. Page text never leaves your device.
- **Lightweight.** The reader is injected only when you ask for it, so pages you do not read are untouched.
- **Open source.** Released under the MIT License.

## Features

| Feature | Description |
|---|---|
| Read aloud | Read a full page or only the selected text, at 0.5x to 4x speed |
| Word highlighting | A highlight follows the voice and the page scrolls along with it |
| Voice picker | Choose any system voice, grouped by page language. Your choice is remembered per language |
| HQ voices | Optional natural sounding voices that run offline: a 9 MB fast voice, or 28 voices from the larger model |
| Speed reading | Shows one word at a time with the focus letter marked, from 100 to 1000 words per minute |
| Summary | An offline key-points summary. Click a sentence to jump to it, or have it read aloud |
| Smart extraction | Skips menus, footers, cookie banners, code blocks, citations such as [1], URLs and emoji. Each rule is configurable |
| Read from here | Hover a paragraph and press play, or Alt+click any sentence |
| Appearance | Four highlight styles, light and dark themes, custom accent colour |
| Extras | Pronunciation dictionary, bookmarks, sleep timer, resume where you left off, listening stats |
| Audio export | Save a page as a WAV file when using an HQ voice |

## Installation

### Chrome Web Store (recommended)

[Install Hearline](https://chromewebstore.google.com/detail/hearline-%E2%80%94-listen-to-any/nnmhcmenlidkfjnhnlmppfkppefeepkb). Updates are applied automatically.

### Build from source

Works in Chrome, Brave and Edge.

```bash
git clone https://github.com/abdisamadjoe/hearline.git
cd hearline
npm install
npm run build
```

Then open `chrome://extensions` (or `brave://extensions`), enable **Developer mode**, click **Load unpacked** and select the `dist` folder.

## Usage

| Action | How |
|---|---|
| Read the page | Click the Hearline icon, or press `Alt+H`. The controls appear; press play |
| Read selected text | Select the text, right-click and choose **Read selection with Hearline** |
| Start from a paragraph | Hover it and press play, or `Alt`+click a sentence. The button stays under the cursor while you move to it |
| Pause or resume | `Space` or the play button |
| Previous or next sentence | `←` and `→` (hold `Shift` to move by paragraph) |
| Change speed | The speed button, or `+` and `-` |
| Change voice | The voice button in the player |
| Summary, speed reading, sleep timer, bookmarks | The `⋯` menu |
| Close | `Esc` or the close button |

**No voices on Ubuntu or Linux?** Install the system speech service and restart your browser:

```bash
sudo apt install speech-dispatcher espeak-ng
```

Alternatively, install the HQ voices from Settings, which need no system speech service.

Hearline never starts speaking by itself: opening a page shows the controls and waits for play.

## HQ voices

HQ voices are optional and run entirely on your device — nothing you read is ever sent anywhere. There are two of them to install, and you can have both.

| | The fast voice | More voices |
|---|---|---|
| Model | Paradee‑8M — [Kokoro's voice distilled into 8 million parameters](https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0) (Apache-2.0) | [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache-2.0) |
| Voices | One American female voice | 28 US and UK English voices |
| Download | 9 MB, once | about 95 MB for six voices, more for all 28 |
| Speed on a typical laptop | around 4x faster than playback | often near or below playback speed |

Both are English only; other languages use system voices. Hearline runs a short speed test after each install. If your computer cannot generate speech faster than it plays, that voice is not used by default — you can still pick it manually, and your system voice stays the default. Repeat the test any time from Settings.

Speech is generated a sentence or two ahead of playback, and the silence the models leave at the end of every chunk is trimmed, so sentences follow each other in about 0.2 s rather than a full second.

The fast voice also makes highlighting exact: the model reports where it is in the text, so the highlight follows the word being spoken rather than an estimate from the audio position.

> **Note:** HQ voices run on the CPU. Hearline measures your machine when you install one — if it cannot generate speech faster than it plays, that voice is not used by default and a system voice is a better choice.

## Privacy

- No account, analytics or telemetry.
- Page text is spoken only by your browser's speech service or by the on-device HQ voices.
- The only network request is the optional one-time HQ voice model download (Paradee or Kokoro) from Hugging Face, which starts when you click **Install**.
- Settings, bookmarks and reading positions are stored locally in `chrome.storage.local`.

### Permissions

| Permission | Purpose |
|---|---|
| `activeTab`, `scripting` | Run the reader on a page only when you ask |
| `storage` | Save settings, bookmarks and reading position |
| `contextMenus` | The right-click "Read selection" option |
| `offscreen` | Play HQ voice audio |

No access to any website is requested in advance.

## Tech stack

![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Web Speech API](https://img.shields.io/badge/Web%20Speech%20API-0A7FFF?style=for-the-badge&logo=googlechrome&logoColor=white)
![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?style=for-the-badge&logo=webassembly&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-005CED?style=for-the-badge&logo=onnx&logoColor=white)
![Kokoro 82M](https://img.shields.io/badge/Kokoro-82M-8b5cf6?style=for-the-badge)
![Paradee 8M](https://img.shields.io/badge/Paradee-8M-22c55e?style=for-the-badge)
![Hugging Face](https://img.shields.io/badge/Hugging%20Face-FFD21E?style=for-the-badge&logo=huggingface&logoColor=black)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css&logoColor=white)
![esbuild](https://img.shields.io/badge/esbuild-FFCF00?style=for-the-badge&logo=esbuild&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)

| Layer | Technology |
|---|---|
| Platform | Chrome Manifest V3 with on-demand injection |
| System voices | Web Speech API |
| HQ voices | Paradee-8M and Kokoro-82M with ONNX Runtime Web (WASM). The offscreen document hosts one worker per engine |
| Highlighting | CSS Custom Highlight API and a shadow DOM overlay. The page itself is not modified |
| Storage | `chrome.storage.local` |
| Code | Plain JavaScript. esbuild is used only to bundle the HQ voice engine |

## Development

```bash
npm install
npm run build              # build into dist/
npm test                   # unit tests
node test/e2e/run.mjs      # real browser smoke test (requires Chromium)
node test/e2e/paradee.mjs  # installs the fast voice and reads a page with it
node test/e2e/kokoro.mjs   # installs the larger voice set and reads a page with it
npm run package            # create hearline-<version>.zip
```

The HQ voice tests need the model files. `test/e2e/paradee.mjs` serves the pinned 9 MB model from `test/e2e/fixtures/`, and the speed-test install path is exercised too; the Kokoro test seeds its 92 MB model into the extension's cache from the same folder. Both also run against the real download when the fixture is absent.

### Project structure

```
hearline/
├── src/
│   ├── manifest.json, background.js   injection, shortcuts, context menu
│   ├── shared/                        settings, text, language, voices, HQ voice rules (unit tested)
│   ├── content/                       extract, engines, reader, player, speed reading, summary
│   ├── popup/                         toolbar popup
│   ├── options/                       settings page and HQ voice installer
│   └── offscreen/                     HQ voice playback, and one inference worker per engine
├── test/                              unit tests and real browser tests (test/e2e/)
├── build.mjs                          builds dist/ and the store zip
├── plan.md                            roadmap
└── CHANGELOG.md
```

## Contributing

Contributions are welcome. Please open an issue to discuss a feature or bug before submitting a pull request.

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit your changes
4. Push the branch and open a pull request

## License

Released under the [MIT License](LICENSE).

## Author

Built by [@abdisamadjoe](https://github.com/abdisamadjoe). If Hearline helps you, please star the repository and leave a review on the Chrome Web Store.
