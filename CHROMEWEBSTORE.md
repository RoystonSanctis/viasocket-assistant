# Chrome Web Store Listing — viaSocket Assistant

> Aligned with official Google Chrome Web Store guidelines:  
> [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)  
> Last Updated: 2026-10-25 (v0.4.0)

---

## 1. Store Listing Metadata

### Item Title
```text
viaSocket Assistant
```
* **Best Practice Check**:
  - ✅ **Clear and descriptive**: Explains what it does (Assistant for viaSocket).
  - ✅ **Concise & Memorable**: Under 25 characters; no keyword stuffing.
  - ✅ **Brand-aligned**: Uses the official product name.

---

### Item Summary (Short Description)
*Maximum 132 characters; plain text only; no HTML; no superlatives ("best", "fastest"); no references to competing extensions. The dashboard reads it from the package: it is `description` in `extension/src/manifest.json`, so change it there.*

```text
A voice-first mascot that builds, tests and improves your viaSocket workflows and plugs.
```
* **Character count**: 88 / 132 characters.
* **Best Practice Check**:
  - ✅ Fits under the strict 132-character limit for search results and category cards.
  - ✅ Highlights core features that resonate with main user cases.
  - ✅ Avoids superlatives, buzzwords, and keyword stuffing.

---

### Item Detailed Description
*Format: plain text (the store does not render Markdown), one emoji per section heading, short benefit-first lines. Max 16,000 characters. No competitor names, no superlatives, and no lists of brand or product names (AI providers, apps, models): v0.4.0 was rejected on 2026-10-25 for "excessive keywords" (Spam and placement, reference Yellow Argon) over a list of AI provider names.*

```text
Build, edit, test and fix viaSocket workflows by chatting or talking to SOCKET, right on your flow canvas.

Describe the automation you want in plain words. SOCKET plans it with you, adds the trigger and the steps, fills in every field, tests each step as it goes and publishes only when you say yes, all inside the viaSocket editor you already use.

🧠 Plans before it builds
Ask for an automation in plain words. SOCKET shows a step-by-step checklist (trigger, steps, test, publish) and waits for "Looks good, start" or your changes.

🧩 Builds complete flows
Triggers, app actions, JavaScript, API calls, multipath conditions, delays, human approvals, AI agents, run-once-per-item loops, run-if conditions and Get Data: configured, connected and saved step by step.

✅ Tests as it goes
Every step is tested right after it is saved, so later steps map real response data instead of guesses. Steps that send messages or change records ask you before they run.

👀 Sees what you see
SOCKET knows which panel is open, what you already picked and what you already tested, so it never asks you twice.

🔤 More power in English flows
Add a JS step with the + button on the Flow view, delete steps from the step menu, and let SOCKET add delays, approvals, loops and run-if conditions.

⚡ Subfunctions panel for JS steps
Add app actions inside a JavaScript step with a full form: connection picker, dropdowns that load from the app, generated fields and data mapping. SOCKET writes the call into your code and keeps the form and the code in sync.

📋 Copy, paste, export and import
Copy a step with its code, mappings and app settings, and paste it into another flow or account. Export a whole flow to a file and import it anywhere.

✨ One-click Beautify
Tidy JavaScript and JSON in the step code editors without changing what the code does.

🗺️ Explains any flow
Ask "How does this flow work?" for a guided walkthrough, or ask why the last run failed.

🛠️ Developer Hub plugs
Build and extend your own viaSocket apps: actions, triggers, connections, test runs and publishing.

🎙️ Talk or type
Hold a shortcut to talk, say "Hey Socket", or type. Speech recognition can run fully on your device.

🤖 Bring your own AI
Connect the AI model you prefer with your own API key, or run a local model on your computer.

🔒 Private by design
No telemetry or analytics. The extension talks only to viaSocket and the AI provider you choose. Your settings and keys stay in your browser. Open source under AGPL-3.0.

💡 How it works
1. Install the extension and open a workflow on flow.viasocket.com.
2. Open the extension options and add your AI provider key, or pick a local model.
3. Click SOCKET (the green mascot) or press Shift + Space.
4. Say or type what you want, for example: "When my webhook gets an order, add a row to my spreadsheet."
5. Review the plan, say "Looks good", and watch the flow build itself.

✅ Made for
• New viaSocket users who want a guide while they build
• Builders who want flows done in minutes
• Developers who write JavaScript steps and custom apps
• Teams who maintain and debug existing flows

💬 Try asking
• "When a form is submitted, add a row to my spreadsheet and message the sales team."
• "Explain this flow step by step."
• "Why did the last run fail?"
• "Wait two days before sending the follow-up email."
• "Only run this flow when the order total is over 100."

ℹ️ Refresh any open viaSocket tabs after installing.

🆘 Support
• Issues and source: https://github.com/RoystonSanctis/viasocket-assistant
• Website: https://viasocket.com
• Email: support@viasocket.com
```

---

### Category
```text
Developer Tools
```

### Primary Language
```text
English
```

### Single Purpose Description
```text
Assists users in building, configuring, testing, and debugging viaSocket workflows using natural language chat and voice commands.
```

---

## 2. Graphic Assets & Design Guidelines

Per Google's [Best Listing Images Guide](https://developer.chrome.com/docs/webstore/best-listing#images), visual assets must be crisp, full-bleed (no artificial padding or rounded corners), reflect the current version (v0.4.0), and maintain consistent branding.

### Assets Specifications Table

| Asset | Exact Dimensions | Format | Status | Design Requirements / Rules |
| :--- | :--- | :--- | :--- | :--- |
| **Store Icon** | **128 × 128 px** | PNG | ✅ Ready (`store-assets/icon-128.png`) | • Simple, recognizable brand logo (SOCKET mascot or viaSocket mark).<br>• High-contrast background.<br>• **NO** screenshots or tiny UI elements inside the icon. |
| **Screenshot 1** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-2-chat-plan-1280x800.png`) | • **Plans before it builds**: chat request turned into a step-by-step plan with "Looks good, start". |
| **Screenshot 2** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-3-english-flow-subfunctions-1280x800.png`) | • **English flows + Subfunctions**: Flow view with the Subfunctions panel and the **+** (Add JS step) on the zoom bar. |
| **Screenshot 3** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-4-subfunction-inputs-1280x800.png`) | • **Subfunction form**: app action inputs with loaded dropdowns and mapped Column Values. |
| **Screenshot 4** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-1-1280x800.png`) | • **Explains any flow**: SOCKET walking through an existing branching flow. |
| **Screenshot 5** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-6-step-copy-paste-1280x800.png`) | • **Copy & Paste steps**: step menu with Copy and Paste on the canvas. |
| *Spare* | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-5-flow-export-import-1280x800.png`) | • **Export / Import Flow** in the flow menu. The store takes at most 5 screenshots: swap this in for any of the above if preferred. |
| **Small Promo Tile** | **440 × 280 px** | PNG | ✅ Ready (`store-assets/promo-small-440x280.png`) | • Appears in search results and category listings.<br>• Dark navy-to-teal background with the canvas dot grid, SOCKET mascot (icon colours `#5DCAA5` / `#162B26`) and the 30 px bold tagline "Build viaSocket flows with **AI & Voice**".<br>• Legible at 50% (text stays 15 px bold).<br>• No badges or claims. |
| **Marquee Promo Tile** | **1400 × 560 px** | PNG | ✅ Ready (`store-assets/promo-marquee-1400x560.png`) | • Used when featured in the top carousel of the Chrome Web Store.<br>• Large SOCKET mascot on the left; "viaSocket Assistant", "Build viaSocket flows with AI & Voice" and "Plan, build, test and fix workflows by chatting with SOCKET." on the right.<br>• Same palette and mascot as the icon and screenshots. |

---

## 3. Additional Store Fields

| Field | Value | Purpose |
| :--- | :--- | :--- |
| **Official Website URL** | `https://viasocket.com` | Builds trust and links to the core product. |
| **Support URL** | `https://github.com/RoystonSanctis/viasocket-assistant/issues` | Direct path for users to file issues or get help. |
| **Privacy Policy URL** | `https://github.com/RoystonSanctis/viasocket-assistant/blob/main/PRIVACY.md` | Required when requesting host permissions. |

---

## 4. Permissions Justification (Developer Dashboard)

| Permission | Category | User-Facing Justification |
| :--- | :--- | :--- |
| `storage` | API Permission | Saves user preferences, mascots' screen position, voice settings, and custom AI provider configurations locally in the browser. |
| `cookies` | API Permission | Reads existing authenticated viaSocket session cookies so the assistant can interact with your workflows without requiring a redundant login. |
| `offscreen` | API Permission | Runs client-side audio processing and local speech recognition in a sandboxed offscreen document to ensure zero latency and keep the UI responsive. |
| `alarms` | API Permission | Periodically checks for workflow sync updates and cleans up expired temporary state. |
| `tts` | API Permission | Provides optional spoken audio feedback when voice replies are enabled. |
| `scripting` | API Permission | Safely injects the SOCKET companion and assistant chat panel into viaSocket flow canvas pages. |
| `https://flow.viasocket.com/*` | Host Permission | Core domain: enables assistant mascot and workflow inspector to operate on viaSocket flow builder pages. |
| `https://beta-flow.viasocket.com/*` | Host Permission | Enables inspecting and testing workflows on viaSocket beta environments. |
| `https://dev-flow.viasocket.com/*` | Host Permission | Enables building and debugging workflows on viaSocket development environments. |
| `https://flow-api.viasocket.com/*` | Host Permission | API access to query flow layouts, save step drafts, and execute dry-run tests. |
| `https://dev-api.viasocket.com/*` | Host Permission | API access for development environment testing. |
| `https://flow.sokt.io/*` | Host Permission | Inspects and triggers test webhooks during workflow development. |
| `https://dev.sokt.io/*` | Host Permission | Development webhook testing domain. |
| `https://raw.githubusercontent.com/*` | Host Permission | Downloads updated selector mappings and tool schemas so the extension adapts to viaSocket UI updates without requiring emergency store releases. |
| `https://*.huggingface.co/*` | Host Permission | Downloads open-source Whisper speech model weights for private, on-device transcription. |
| `https://*.hf.co/*` | Host Permission | CDN mirror for Hugging Face speech model weights. |

---

## 5. Developer Console Submission Form (Exact Answers)

### 1. Host Permission Justification
*Paste into the **Host permission justification** text area (max 1,000 characters):*

```text
viaSocket Assistant operates on viaSocket workflow builder pages to help users build, test, and inspect automations:

1. *.viasocket.com & *.sokt.io: Injects the assistant mascot on viaSocket flow canvases (production, beta, dev) and interacts with viaSocket APIs to inspect step configurations, test executions, and apply changes requested by the user.
2. raw.githubusercontent.com: Downloads public, open-source selector maps and tool configuration updates so the extension remains resilient to minor UI updates.
3. *.huggingface.co & *.hf.co: Downloads public open-source Whisper speech-to-text model weights for on-device, private audio transcription directly in the browser.

No user browsing history or personal data is collected or tracked.
```

---

### 2. Are you using remote code?
* Select: **⚪ No, I am not using remote code**
> **CRITICAL**: Do **NOT** select "Yes". All extension JavaScript and WebAssembly modules (ONNX Runtime WASM) are bundled directly inside the extension package. Downloading JSON configuration maps and AI tensor model weights is standard data loading, not remote code execution.

---

### 3. Data Usage / Privacy Disclosures

#### User Data Collection
* **Leave all 9 checkboxes UNCHECKED**:
  - [ ] Personally identifiable information
  - [ ] Health information
  - [ ] Financial and payment information
  - [ ] Authentication information
  - [ ] Personal communications
  - [ ] Location
  - [ ] Web history
  - [ ] User activity
  - [ ] Website content

*(The extension collects zero telemetry or analytics on external servers. All operations run locally or communicate directly with the user's active viaSocket session.)*

#### Certification Checkboxes
* [x] **I do not sell or transfer user data to third parties, apart from the approved use cases** (CHECK THIS)
* [x] **I do not use or transfer user data for purposes that are unrelated to my item's single purpose** (CHECK THIS)
* [x] **I do not use or transfer user data to determine creditworthiness or for lending purposes** (CHECK THIS)

---

### 4. Reviewer Test Instructions

#### Credentials:
* **Username:** *(Leave blank)*
* **Password:** *(Leave blank)*

#### Additional instructions (max 500 characters):
```text
No credentials required. Reviewers can test freely:

1. Visit https://flow.viasocket.com and create a free account.
2. Open any workflow. SOCKET (the green mascot) appears automatically on the canvas.
3. Click SOCKET or press Shift + Space to toggle the interactive chat window.
4. Drag SOCKET or the chat panel anywhere to test UI docking and responsiveness.
5. Right-click extension icon -> Options to view settings, audio output preferences, and speech recognition options.
```

---

## 6. Pre-Submission Quality Checklist

Before submitting to the Chrome Web Store dashboard:

- [ ] **Package Check**: Run `npm run check` in `extension/` to ensure zero TypeScript errors, valid configuration schemas, and clean build output.
- [ ] **Manifest Version**: `manifest.json` matches release version (e.g. `0.4.0`).
- [ ] **Icons**: `128×128`, `48×48`, `32×32`, and `16×16` icons present in `dist/icons/`.
- [ ] **Screenshots**: At least 1 (recommended 5) screenshots formatted at 1280×800, full bleed, crisp text, and highlighting actual workflow UI.
- [ ] **Promo Tiles**: 440×280 promo tile created with high contrast and legible typography at small scale.
- [ ] **Policy Adherence**: No superlatives in title/summary; no mention of competing brands; single-purpose clearly defined as developer automation assistant.
- [ ] **Zip Package**: Packaged zip contains only `manifest.json` and contents of `dist/`; no source files, `.git`, or hidden directories.
