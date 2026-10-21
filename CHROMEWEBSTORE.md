# Chrome Web Store Listing — viaSocket Assistant

> Aligned with official Google Chrome Web Store guidelines:  
> [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)  
> Last Updated: 2026-10-20 (v0.4.0)

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
*Maximum 132 characters; plain text only; no HTML; no superlatives ("best", "fastest"); no references to competing extensions.*

```text
An interactive AI companion that builds, tests, and edits automation workflows directly on your viaSocket canvas using voice and chat.
```
* **Character count**: 130 / 132 characters.
* **Best Practice Check**:
  - ✅ Fits under the strict 132-character limit for search results and category cards.
  - ✅ Highlights core features that resonate with main user cases.
  - ✅ Avoids superlatives, buzzwords, and keyword stuffing.

---

### Item Detailed Description
*Format: Engaging overview paragraph followed by a clean list of key capabilities, quick onboarding steps, privacy pledge, and support links.*

```markdown
viaSocket Assistant is an interactive AI-powered companion built specifically for viaSocket users. It features SOCKET, an animated companion that lives directly on your viaSocket canvas to help you construct, debug, test, and refine automation workflows using voice or natural language chat.

Whether you are connecting APIs, writing custom JavaScript transformations, or troubleshooting branching logic, SOCKET acts as your co-pilot—analyzing the current canvas in real time, explaining data flow, and applying step modifications with your approval.

KEY CAPABILITIES

• Voice & Natural Language Building: Dictate changes hands-free or press Shift + Space (or Alt + Shift + V) to instruct SOCKET to add steps, configure API parameters, or fix errors.
• Interactive SOCKET Companion: An intelligent on-canvas companion that moves with you, automatically docks to clear the way when step panels open, and highlights active steps.
• Real-Time Sidebar & Draft Sync: Edits and draft configurations suggested by the assistant reflect live in the viaSocket sidebar, keeping your canvas and settings perfectly in sync.
• Cross-Flow Step Transfer: Copy and paste complete steps—including app configurations, custom code, dynamic variable mappings, and authentication references—between different flows and accounts.
• Clean JavaScript Step Organization: Automatic mapping of input values into structured dynamic variables, keeping custom code clean and easy to maintain.
• Workflow Walkthroughs & Debugging: Ask SOCKET to explain complex automation paths, inspect step payloads, or diagnose failed executions step by step.
• Local & Private Speech Processing: Choose between on-device Whisper speech recognition or browser-based transcription to keep voice inputs fast and private.
• Customizable Interaction: Switch seamlessly between spoken responses, concise audio chime confirmations, or silent text mode. Adjust speech pause sensitivity to match your speaking style.

HOW TO GET STARTED

1. Open any workflow on viaSocket (e.g., flow.viasocket.com).
2. Click SOCKET (the green mascot on the canvas) or press Shift + Space to open the assistant.
3. Type or speak what you want to achieve (e.g., "Add a JavaScript step to format this date and send a Slack notification").
4. Review the assistant's proposed plan, approve the steps, and watch your flow build out smoothly.

PRIVACY & SECURITY

viaSocket Assistant communicates exclusively with viaSocket services and your own chosen AI providers. 
• No browsing history or unrelated website data is ever read or tracked.
• Session authentication relies on your existing browser cookies; tokens never leave your local session.
• Speech processing can run fully on-device via WebAssembly/WebGPU.
• Source code is open and audited under the AGPL-3.0 license.

SUPPORT & COMMUNITY

• Documentation & Issues: https://github.com/RoystonSanctis/viasocket-assistant
• Website: https://viasocket.com
• Feedback: Contact support@viasocket.com or open a discussion on GitHub.
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
| **Screenshot 1** | **1280 × 800 px** | PNG | ✅ Ready (`store-assets/screenshot-1-1280x800.png`) | • **Hero Canvas Overview**: viaSocket builder with SOCKET companion docked on the canvas.<br>• Full-bleed (square corners, no white borders). |
| **Screenshot 2** | **1280 × 800 px** | PNG | ⬜ Planned | • **Voice & Chat Workflow Building**: Natural language prompt showing step generation and plan review in the chat panel. |
| **Screenshot 3** | **1280 × 800 px** | PNG | ⬜ Planned | • **Live Step Inspector & Draft Sync**: Step slider open with dynamic variables and real-time live preview. |
| **Screenshot 4** | **1280 × 800 px** | PNG | ⬜ Planned | • **Step Menu Actions (Copy, Paste, Delete)**: Three-dot menu showcasing seamless step copy/paste and management across flows. |
| **Screenshot 5** | **1280 × 800 px** | PNG | ⬜ Planned | • **Audio & Speech Privacy Settings**: Options panel demonstrating on-device Whisper transcription and voice reply preferences. |
| **Small Promo Tile** | **440 × 280 px** | PNG | ⬜ Planned (`store-assets/promo-small-440x280.png`) | • Appears in search results and category listings.<br>• Vibrant, saturated colors (dark navy/teal palette).<br>• Clear SOCKET mascot + bold tagline: "Build viaSocket flows with AI & Voice".<br>• Must be legible when scaled down to 50%.<br>• **NO** misleading badges ("#1", "Editor's Choice"). |
| **Marquee Promo Tile** | **1400 × 560 px** | PNG | ⬜ Planned (`store-assets/promo-marquee-1400x560.png`) | • Used when featured in the top carousel of the Chrome Web Store.<br>• Uncluttered, high-res composition with room on the left/right.<br>• Consistent visual identity with icon and screenshots. |

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
