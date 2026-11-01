# Privacy policy: viaSocket Assistant

Effective date: 12 October 2026

viaSocket Assistant ("the extension") is an open-source Chrome extension that helps you build and edit workflows and plugs on viaSocket. This policy explains what data the extension handles, where it goes, and how to delete it. The full source code is public, so every statement here can be checked.

## In short

- The extension has no servers of its own. Its developers do not receive your data.
- Your requests go only to the AI provider you choose (with your own key) and to viaSocket's own API, on your behalf.
- No analytics, no tracking, no ads. Your data is never sold or shared for any other purpose.
- Speech recognition runs on your device by default.
- Everything the extension stores stays in your browser, and you can delete it at any time.

## What the extension accesses

| Data | Why |
|---|---|
| Your messages to the assistant (typed or spoken) | To understand and carry out your request. |
| Microphone audio, only while you hold the talk key or press the voice shortcut | To turn speech into text. |
| The viaSocket page you are on: its address, and which flow, project, step or plug is open | So the assistant knows what you are working on. |
| Your viaSocket session token, read from the viaSocket cookie in your browser | So the assistant can call viaSocket's API as you, like the viaSocket web app does. |
| Data returned by viaSocket's API when the assistant uses its tools: flow and step configuration, app and action details, connection names, test results and errors | To build, test and fix what you asked for. |
| Basic facts about your own actions on viaSocket pages (for example "a step test failed" with the error text), observed from the page's own requests | So the assistant can react, for example by offering to explain a failed test. |
| Your AI provider key and settings | To talk to the AI provider you chose and remember your preferences. |

The extension only runs on viaSocket pages. It does not read other websites, your browsing history or other tabs.

## Where data is sent

**Your chosen AI provider.** Your messages, the page context above and the results of the assistant's tools are sent to the AI provider you selected (for example OpenRouter, OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, or a model server on your own computer), using your own key. The provider's own privacy policy and terms apply to what it receives. Some providers' free tiers may use prompts to improve their products; check your provider's terms before use.

**Run data protection.** Run data can contain your customers' details. It covers the payloads that started a flow, step outputs and variables, saved sample outputs, and the results of step, flow and plug test runs. Unless this protection has been switched off in the extension's configuration, the assistant's tools send only the structure of run data to the AI provider:

- field names and the paths to them, such as `context.req.body.email`. A name that itself looks like data (it contains an email address or a long number) is replaced by `<key>`;
- the shape of each value instead of the value, for example `<email>`, `<phone>`, `<digits:16>`, `<date>`, `<url>`, `<string:12>` or `<number>`. True/false, empty and null values are kept, and long lists are cut to their first items;
- error messages and console output from test runs, shortened, with email addresses, phone numbers, long numbers, token-like strings and longer quoted values masked. The same masking applies to the name of the connection a plug test run used, and to the error text of your own failed saves, tests and publishes that the extension observes on the page.

What you or the assistant configured is not run data. It is sent as saved, for example step code, field values and mappings, and request addresses. In flow steps, header, query, form field and named-constant values whose names look like secrets (for example containing "token", "key" or "password") are masked before they are sent.

**viaSocket.** When the assistant uses a tool (for example to add a step or run a test), it sends the request to viaSocket's API with your session token, exactly as the viaSocket web app would. viaSocket's privacy policy applies.

**Downloads that carry none of your data.** The extension downloads its public configuration from GitHub (`raw.githubusercontent.com`) and, the first time you use voice, a speech recognition model from Hugging Face. These are ordinary file downloads: the services see standard request details such as your IP address, but no content from you.

**Optional browser speech recognition.** If you switch the speech engine from on-device Whisper to the browser's built-in recognition, your browser processes the audio with its own speech service; in Google Chrome that service is run by Google. The on-device engine is the default.

Nothing else is sent anywhere. Your AI key is only ever sent to the address it was saved for.

## What is stored, and where

All of the following stays on your computer, inside your Chrome profile:

- your settings (provider, model, voice and proactivity preferences), in the extension's storage (`chrome.storage.local`);
- your AI provider key, in the extension's own database (IndexedDB), which only its background service worker opens. The key is used only there and is never shown in full again;
- recent conversation history, one thread per flow or plug, capped in length, in the extension's session storage, which Chrome clears when it closes and when the extension is updated. Conversations from incognito windows are kept only in memory and never written to storage;
- the last valid copy of the public configuration, in `chrome.storage.local`;
- the speech recognition model files, in the browser cache after the first download.

Audio is processed in memory and never saved. The viaSocket session token is read from your browser's cookie when needed and is not stored by the extension.

## Deleting your data

- **Conversation:** use the clear button in the assistant's chat panel to delete the current thread.
- **AI key:** remove it on the extension's options page. You can also revoke the key on your provider's website.
- **Everything:** uninstall the extension from `chrome://extensions`. Chrome deletes all of the extension's stored data, including keys, settings, history and cached files.

Data already sent to your AI provider or to viaSocket is governed by their policies; contact them to delete it.

## Chrome Web Store user data policy

The use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Data is used only to provide the assistant's features you use, is not transferred except as described above, is not used for advertising, credit decisions or any purpose unrelated to the extension, and is not read by humans.

## Children

The extension is a tool for viaSocket users and is not directed at children under 13.

## Changes to this policy

Changes are published in the extension's public repository together with the code, with a new effective date. Significant changes will also be noted in the release notes.

## Contact

Questions or concerns: open an issue at <https://github.com/RoystonSanctis/viasocket-assistant/issues>.
