# Chrome Web Store Listing — viaSocket Assistant

> Last Updated: 2026-10-18

## Store Listing

**Extension Name**
viaSocket Assistant

**Short Description**
A voice-first mascot assistant that builds, tests, and improves your viaSocket workflows and plugs.

**Detailed Description**
viaSocket Assistant is an interactive AI-powered assistant designed specifically for viaSocket users. It sits quietly as a friendly, movable mascot in the corner of your viaSocket canvas and helps you construct, debug, and explain automation workflows using natural language or voice commands.

Key Features:
- Voice-First Interaction: Wake up the assistant hands-free or with a quick keyboard shortcut (Shift + Space or Alt + Shift + V) to dictate workflow changes, fix errors, or configure new steps.
- Interactive Mascot: Draggable anywhere on the screen, intelligently avoids covering your workflow nodes, and automatically docks to clear the way when configuring steps.
- Explain & Inspect Workflows: Understand complex automation logic with step-by-step interactive walkthroughs and visual highlights.
- Full Audio & Proactivity Settings: Easily switch between full spoken answers, minimal audio replies, or silent text mode. Adjust speech pause sensitivity to match your speaking pace.
- Flexible Draggable Chat Window: Pop open the SOCKET panel anywhere you need it, move it freely, and double-click the header to reset it back beside your mascot.
- Local & Private Speech Options: Transcribe speech on-device or via browser recognition without sending private recordings to unknown servers.

How to use it:
1. Open any viaSocket flow (e.g. flow.viasocket.com).
2. Click the green SOCKET mascot orb or press Shift + Space to open the assistant.
3. Type or speak your instructions (e.g. "Add a step to send a Slack alert when a row is created in Google Sheets").
4. Review the generated plan, approve steps, and watch your automation build out smoothly.

Privacy & Security:
viaSocket Assistant is open source (AGPL-3.0) and communicates directly with viaSocket and your configured AI providers. Your credentials and session tokens never leave your browser.

Support:
Report issues or contribute at: https://github.com/RoystonSanctis/viasocket-assistant

**Category**
Developer Tools

**Single Purpose**
Assists users in building, testing, and debugging viaSocket workflows using voice and natural language commands.

**Primary Language**
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `store-assets/icon-128.png` (or `extension/public/icons/icon-128.png`) |
| Screenshot 1 [REQUIRED] | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-1-1280x800.png` (or `docs/screenshots/screenshot-1-1280x800.png`) |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves user preferences, UI position/docking coordinates, voice settings, and API configuration locally in the browser. |
| `cookies` | permissions | Reads existing authenticated viaSocket session cookies so the assistant can interact with your workflows without requiring separate login. |
| `offscreen` | permissions | Runs client-side audio processing and local speech recognition in a sandboxed offscreen document without impacting page responsiveness. |
| `alarms` | permissions | Periodically checks for workflow status updates and cleans up expired local state. |
| `tts` | permissions | Provides spoken audio feedback when the user enables voice reply mode. |
| `scripting` | permissions | Injects assistant UI components (orb mascot and chat panel) safely into viaSocket flow canvas pages. |
| `https://flow.viasocket.com/*` | host_permissions | Core domain: enables the assistant mascot and workflow inspector to operate on viaSocket flow builder pages. |
| `https://beta-flow.viasocket.com/*` | host_permissions | Enables testing and building workflows on viaSocket beta environments. |
| `https://dev-flow.viasocket.com/*` | host_permissions | Enables building and testing workflows on viaSocket dev environments. |
| `https://flow-api.viasocket.com/*` | host_permissions | API access to query flow structure, save step configurations, and dry-run workflow executions. |
| `https://dev-api.viasocket.com/*` | host_permissions | Development API access for workflow operations. |
| `https://flow.sokt.io/*` | host_permissions | Inspects and triggers webhooks and test events during workflow construction. |
| `https://dev.sokt.io/*` | host_permissions | Development webhook testing domain. |
| `https://raw.githubusercontent.com/*` | host_permissions | Loads up-to-date selector maps and tool schemas from the open-source configuration repository without requiring an extension update. |
| `https://*.huggingface.co/*` | host_permissions | Downloads on-device Whisper speech recognition models for private, client-side transcription. |
| `https://*.hf.co/*` | host_permissions | CDN domain for Hugging Face model weight downloads. |

---

## Privacy & Data Use

### Data Collection
**Does the extension collect user data?** No user data is collected, sold, or shared with third parties.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Authentication info | Yes (cookies) | Only to viaSocket API | Authenticates user's existing viaSocket session | No |
| User activity | Yes (workflow context) | Only to viaSocket / LLM provider | Analyzes current workflow canvas to build steps | No |
| Website content | Yes (viaSocket canvas DOM) | Only to viaSocket / LLM provider | Inspects step nodes to guide and explain flows | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's single purpose
- [x] Data is NOT used for creditworthiness or lending decisions
