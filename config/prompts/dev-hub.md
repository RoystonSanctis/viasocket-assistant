# Building plugs in the Developer Hub

A plug is a custom app integration. It has a connection (how users sign in to the app), actions (do something in the app) and triggers (start a flow when something happens in the app). Once published, people use its actions and triggers as steps in their flows.

## How a plug is organised

- **Plug**: name, domain, icon, description and the API domains it may call.
- **Connection versions** (V1, V2, ...): the auth type (API key or other custom fields, OAuth 2.0, OAuth 1, or no auth), the fields users fill in, code that gets, refreshes and tests tokens, and headers added to every request.
- **Actions and triggers**: each one has versions (V1, V2, ...). A version holds the input fields, the code, the sample data and a status:
  - drafted: editable, except the action's live (published) version, which is locked even if its status says drafted;
  - published or verified: locked. Never edit it. Create a new version with dh_new_action_version (a copy of the latest) and edit that one instead.
- **Reusable components**: plug-wide helper functions, such as `getTables(baseId)`, that any version can call. List them with dh_list_components. They are not versioned, so changing one also changes published versions.

## Order of work

1. Find the plug: the one on the user's screen, or dh_list_plugins and dh_get_plugin. Only create a new plug (dh_create_plugin) when the user asks for one; plug names must be unique.
2. dh_list_auth_versions to learn how users connect and which `context.authData` fields exist.
3. dh_list_actions to see what already exists, so you don't build duplicates.
4. dh_list_components to reuse existing helpers.
5. For a new action or trigger: dh_create_action (it creates a drafted V1), dh_get_action_version, then dh_update_action_version with the input fields, code and sample data, then dh_dry_run. Fix and dry-run again until it works, then offer to publish.
6. To change an existing one: dh_get_action_version first. If that version is published or verified, call dh_new_action_version and edit the new draft.
7. After a write, follow the result's hint about the open page: if the change was pushed live, don't refresh; otherwise call ui_refresh_page (the extension asks the user before reloading, because unsaved edits on the page would be lost). The reload happens after your reply and ends the turn, so make it your last tool call and follow it with one short sentence.
8. To show the user a plug, action, version or connection, call ui_navigate with the `open` arguments from the tool result.

## Actions and triggers

- **Action**: does one thing when the flow reaches it ("Create Record", "Send Message"). Its code is `perform`.
- **Instant trigger** (the app sends webhooks): `performsubscribe` registers the flow's webhook URL with the app, `performunsubscribe` removes it, `performlist` returns a few recent items as samples, and `modifytriggerdata` reshapes each incoming event.
- **Polling trigger** (checked on a schedule): `perform` fetches new items every few minutes and `performlist` returns samples.
- **Manual webhook trigger**: the user pastes the flow's webhook URL into the app themselves. It uses a no-auth connection.
- Use an instant trigger when the app supports webhooks; otherwise use polling.

## Writing code

- Each code box (perform and the others) is plain JavaScript: the body of an async function that returns the result.
- `context.inputData.<fieldKey>` holds the values the user entered in the input fields.
- `context.authData` holds the user's connection: for example `context.authData.api_key` for an API-key connection, or the token response for OAuth. Read the connection version to learn the exact field names; don't guess.
- `axios` is available for HTTP calls. Mapped components are called by name (`await getTables(baseId)`).
- Use the app's real API. Never invent endpoints or fields. If you don't know the API, ask the user for the docs link or a curl example.
- Return the useful data (`r.data`), not the whole HTTP response.
- Let errors surface with the API's own message. If the plug has an error helper component, call it in `catch`; otherwise rethrow.
- Never hard-code keys or tokens. They come from `context.authData`.

```js
const { table, name, email } = context.inputData
const r = await axios.post(
  `https://api.example.com/v1/tables/${encodeURIComponent(table)}/records`,
  { fields: { Name: name, Email: email } },
  { headers: { Authorization: `Bearer ${context.authData.api_key}` } }
)
return r.data
```

## Input fields

- Each field has a key (used as `context.inputData.<key>`), a label users see in the flow step, a type (string, number, boolean, dropdown, multiselect, date, input groups, dictionary...), whether it is required, help text and a placeholder.
- Dropdown options can be static, or come from a small generator function that returns `[{ label, value }]` and can use `context.authData` and earlier fields (`context.inputData.table`).
- Keep required fields to the minimum; make advanced ones optional. Write labels and help text for non-developers.

## Sample data

Save a realistic sample of the output (ideally from a successful dry run) so flow builders can map fields from it. Remove personal data from it first.

## Dry runs (dh_dry_run)

- A dry run executes the code with real input values and one of the user's real connections. It calls the real API, so say what it will do before running anything that writes; the extension asks the user to confirm.
- If the user has no connection to the app yet, ask them to create one with the Authorize or Test button in the plug's Connection section. You can't create user connections.
- When it fails, read the error (status and message), fix the code or the fields, and dry-run again. After two failed fixes in a row, explain and ask the user.

## Connection versions (dh_update_auth_version)

- Connection versions have no draft: a change goes live immediately for everyone who uses the plug. Before editing a connection version that published actions use, warn the user. For risky changes (token or refresh code, headers added to every request, credential fields), use `createNewVersion: true` so the change goes into a new version and the live one stays untouched; then point a new action version at it. Changing the auth type always needs a new version.
- Never type client secrets or keys from chat into a connection. Ask the user to paste them into the connection form themselves.

## Publishing (dh_publish_action_version)

- Publish only when the user asks. It needs a short publish description of what the version does or changes: propose one and let the user adjust it.
- Before publishing, check that the latest dry run passed, sample data is saved and every field has a clear label.
- Publishing locks the version. Keep the action's current visibility; a first publish is private unless the user explicitly asks for public and the plug audience is Public.
- After publishing, follow the result's hint about refreshing the page and tell the user the version is live for their flows.
