# viaSocket Assistant

A community, open-source assistant for [viaSocket](https://viasocket.com): a small animated bubble that lives on your viaSocket screen, listens when you hold a key, and builds, edits, tests and explains your workflows and Developer Hub plugs. It uses your own AI key (bring your own key) and acts through the same APIs the viaSocket web app uses, as you, in the workspace you have open.

## Features

- **Voice first.** Hold a key and talk; speech recognition runs on your device. Short replies can be spoken back.
- **Builds flows.** Sets triggers (webhook, schedule, email, app events), finds apps and actions, checks connections, adds and maps steps one at a time, writes code steps, tests them and fixes errors. Your open editor updates live.
- **Builds plugs.** Finds plugs in the Developer Hub by name, then extends the existing one or creates a new plug: its connection, helper components, actions and triggers, with their code and input fields, following the Developer Hub plug skill and its knowledge base. It dry-runs only read-only parts with your own connection and publishes, privately, only after you say yes.
- **Shows its work.** Flies to the step or field it changed and highlights it, opens step panels, and keeps a short thinking line next to the bubble.
- **Reacts to you.** Notices failed tests, publishes and errors on the page and offers to explain or fix them. How chatty it is depends on the proactivity setting (quiet, helpful or proactive).
- **Keeps you in control.** Deleting, publishing, discarding and overwriting always ask first, with a button.
- **English, Hindi and Hinglish.** It replies in the language you use.

## How it fits together

```
 viaSocket tab (flow.viasocket.com, beta-flow, dev-flow)
 +-------------------------------------------------------------------+
 | page-hook.js   MAIN world, document_start                         |
 |   wraps the page's XHR/fetch, always calls through, and reports   |
 |   only method, path and status of viaSocket API calls             |
 |        |  window.postMessage {__vsAssistant: {..., nonce}}        |
 |        v                                                          |
 | content.js     isolated world                                     |
 |   mascot + chat panel in its own shadow root, highlights,         |
 |   push-to-talk keys, router-friendly navigation                   |
 +--------|----------------------------------------------------------+
          |  chrome.runtime port "assistant"
          v
 background.js  service worker (the only place keys and tokens exist)
   agent loop --> LLM adapter (openai | anthropic) --> your AI provider
   tools ------> viaSocket client -----------------> viaSocket API, as you
   config loader --> raw.githubusercontent.com (config-<channel> branch), else bundled copy
   keys in the worker's own IndexedDB, settings and cached config in
   chrome.storage.local, per-flow and per-plug threads in chrome.storage.session
          |  chrome.runtime messages
          v
 offscreen.html  offscreen document
   microphone + Whisper (Transformers.js, WebGPU or WASM), Web Speech fallback
   speech model downloaded once from huggingface.co, then cached

 options.html   AI provider and key, models, voice, proactivity, config channel
```

A typical request: you hold the hotkey and speak. `content.js` tells the service worker, which asks the offscreen document to listen and transcribe. The transcript goes to the agent loop, which sends the conversation, page context and available tools to your AI provider. Tool calls are validated and run in the service worker against viaSocket's API; changes carry a header that makes your open editor apply them live. Mood, thinking text, chat lines, highlights and confirmation cards flow back to the content script over the port.

## Build

Requires Node.js 20.19 or newer.

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist/` folder.

The build bundles each context with esbuild into `dist/`, copies the ONNX Runtime WASM files the speech bundle actually references (extensions may not load code from a CDN), and copies the sibling `../config` folder's `manifest.json` plus the files it lists into `dist/defaults` as the bundled fallback config. The `config/` folder sits next to `extension/` in this repo. `npm run check-config` validates that folder against the extension's own schemas, tool names and selector keys; `npm run check` runs the typecheck, that validation and the build.

For the Chrome Web Store, zip the contents of `dist/` (not the folder itself).

## Develop

```sh
npm run dev         # rebuild on change (inline source maps)
npm run typecheck   # tsc --noEmit
```

`npm run dev` copies static files and the config once; restart it to pick up changes to those. After a rebuild, click the reload icon for the extension in `chrome://extensions`, then reload the viaSocket tab so the content scripts are replaced.

Source layout:

| Folder | What lives there |
|---|---|
| `src/background/` | Service worker: agent loop, LLM adapters, tools, viaSocket client, config loader, key storage |
| `src/content/` | Content script controller and the mascot UI |
| `src/main-world/` | The MAIN-world network observer |
| `src/offscreen/` | Microphone capture and speech recognition |
| `src/options/` | Options page |
| `src/shared/` | Types and helpers shared by every context (messages, config schemas, settings) |

Prompts, selectors, provider lists and wording live in the [`config/` folder](../config/README.md) of this repo, not here.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Your settings, the cached config and conversation history, on your device. AI keys are kept in the extension's own IndexedDB, which only the service worker opens. |
| `cookies` | Reads your viaSocket session cookie so tool calls act as you. The token is used only inside the service worker, as a header on requests to viaSocket's API. |
| `offscreen` | Service workers can't use the microphone, so listening and speech recognition run in an offscreen document. |
| `alarms` | Re-checks the remote config every 10 minutes. |
| `tts` | Speaks short replies with Chrome's text-to-speech. |
| `scripting` | Starts the assistant in viaSocket tabs that were already open when the extension was installed or updated. |
| `https://flow.viasocket.com/*`, `https://beta-flow.viasocket.com/*`, `https://dev-flow.viasocket.com/*` | The app pages the mascot runs on, and the session cookie read for them. |
| `https://flow-api.viasocket.com/*`, `https://dev-api.viasocket.com/*` | viaSocket's API, called as you. |
| `https://flow.sokt.io/*`, `https://dev.sokt.io/*` | viaSocket's flow runtime, used only to test-run a draft flow. |
| `https://raw.githubusercontent.com/*` | Downloads the public config. |
| `https://*.huggingface.co/*`, `https://*.hf.co/*` | Downloads the speech model once (Hugging Face serves large files from subdomains); it is then cached. |
| Optional: `https://*/*` | Your AI provider's address. Chrome asks when you save a key, and only that origin is granted. |
| Optional: `http://localhost/*`, `http://127.0.0.1/*` | Local model servers such as Ollama or LM Studio. |

## Voice

- **On-device speech recognition.** Whisper runs in the offscreen document via [Transformers.js](https://github.com/huggingface/transformers.js) (ONNX Runtime Web, WebGPU when available, otherwise WASM). The default `whisper-base` model (about 80 MB, multilingual, handles Hindi and Hinglish reasonably well) downloads once on first use. Audio stays on your computer. Other sizes can be picked on the options page.
- **Browser fallback.** You can switch to the browser's own speech recognition (Web Speech API). In Chrome this sends audio to Google's speech service, so only choose it if you are fine with that.
- **Hotkeys.** Hold **Control+Option** on macOS or **Ctrl+Alt** on Windows and Linux to talk, and release to send; the combination can be changed on the options page. Or press **Alt+Shift+V** to start and stop listening (change it at `chrome://extensions/shortcuts`). You can also type in the chat panel.
- **Microphone access** is granted once, from the options page.
- **Spoken replies** use Chrome's text-to-speech for the first sentence of each reply. Turn them off on the options page.

## AI providers (bring your own key)

The assistant needs a model that supports tool calling. Built-in providers: OpenRouter, Groq, Google Gemini, Mistral, OpenAI, Anthropic, DeepSeek, and local servers (Ollama, LM Studio). Others can be added through `config/providers.json`.

**OpenRouter free tier:** free models allow 20 requests a minute and 50 requests a day, or 1,000 a day after a one-time purchase of $10 in credits (free models don't use the credits). One assistant task often takes several requests, one per tool step, so the 50-a-day limit runs out quickly. You can set fallback models on the options page.

Free tiers of some providers may use your prompts to improve their products; check your provider's terms.

## Remote config

The extension downloads prompts, selectors, providers, mascot wording, flags, tool switches and voice settings from this repo's published config branches (`config-stable`, `config-beta`), which the **Config** GitHub Action generates from the [`config/` folder](../config/README.md).

- The address is `CONFIG_REMOTE_BASE` plus `CONFIG_BRANCH_PREFIX` and the channel (`stable` or `beta`, chosen on the options page) in `src/shared/constants.ts`, e.g. `https://raw.githubusercontent.com/RoystonSanctis/viasocket-assistant/config-stable/manifest.json`. Point it at your own repo before publishing a fork, or set it to an empty string to use only the bundled copy.
- Everything is validated with the zod schemas in `src/shared/config.ts`. An invalid or unreachable config never replaces the last good one, and the copy in `dist/defaults` is the final fallback.
- A config whose `minExtensionVersion` is newer than the installed extension is skipped, and the last good one stays. The extension version comes from `package.json` (currently 0.2.0). The current config requires 0.2.0, because its prompts and tool switches use the Developer Hub tools added in that version.
- The config is data only. It can't add tools, change where keys are sent, or remove confirmations.

## Security model

- **Secrets stay in the service worker.** Your AI key and your viaSocket session token are never sent to the content script, the page or the options page (which only sees the last four characters of a key).
- **Keys are bound to an origin.** A key is sent only to the origin it was saved with. Addresses of built-in providers are compiled into the extension, so the remote config can't redirect them.
- **viaSocket access is narrow.** Tools call an allowlisted set of endpoints on viaSocket's API host for your environment, only in the workspace open in your tab, with the token sent as a header and never with cookies. Changes to one flow are queued so they can't overwrite each other.
- **Confirmations are enforced in code.** Deleting, publishing, discarding and overwriting always show a confirmation card, whatever the AI or the config says.
- **AI output is treated as untrusted.** Tool arguments are validated; AI output is never used as a CSS selector, URL or header, and is shown with `textContent`, never `innerHTML`. Page content and tool results are passed to the AI as data.
- **Less data to the AI.** Run data and sample payloads are stripped from flow JSON before it is sent to your provider (configurable with `stripRunData`).
- **No remote code.** No `eval`, no `new Function`, nothing executable is downloaded. The MAIN-world hook only observes, always calls through to the page's original `XMLHttpRequest`/`fetch`, and never throws into the page.
- **Isolated UI.** The mascot renders in its own shadow root and talks to the page hook through one namespaced, nonce-checked message key that the viaSocket app's own listeners ignore.

See [PRIVACY.md](PRIVACY.md) for what data goes where.

## License

AGPL-3.0-or-later. Add the full license text as `LICENSE` (from <https://www.gnu.org/licenses/agpl-3.0.txt>) before publishing.

viaSocket Assistant is a community, open-source assistant for viaSocket.
