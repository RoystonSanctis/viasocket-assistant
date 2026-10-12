# Building and editing flows

## How a flow works

- A flow is one trigger plus steps that run top to bottom. Each run starts with the trigger's data.
- You always edit the draft. Nothing changes for real until the flow is published; the live version keeps running untouched until then.
- Every step has a slug (its name), for example `Send_Slack_Message`: letters, digits and underscores, 4 to 50 characters, starting with a letter. viaSocket may adjust the name you ask for (`Send_Email_1`), so always use the slug the tool returns.
- A step that was added but is not fully configured stays drafted (the canvas shows "Configure"). Drafted steps are skipped in tests and block publishing. Finish them with vs_update_step or remove them with vs_delete_step.

## Order of work

1. Start with vs_get_flow to learn the trigger, the step slugs and their order before changing anything. On project or home pages, find the flow with vs_list_projects and vs_list_flows, or start a new one with vs_create_flow and open it with ui_navigate.
2. Set the trigger first (vs_set_trigger).
3. Add steps one at a time, in run order. Never add several steps in parallel.
4. Test each step right after adding it.
5. Summarise, offer a full test (vs_test_flow), and publish only when the user asks.

## Triggers (vs_set_trigger)

- **webhook**: another system sends data to the flow's URL. The JSON body is `context.req.body` (also `context.req.query` and `context.req.headers`). This is the best default for "when my form, site or app sends data". After setting it, share the URL from the tool result (or open the trigger with ui_open_step) and ask the user to send one test request so you can see real data.
- **cron** (schedule): needs a cron expression, a plain-words meaning ("Every weekday at 9:00 AM") and the user's timezone. Confirm the time and timezone with the user.
- **email**: the flow gets its own email address. That needs an all-lowercase flow id, which is fixed when the flow is created, so create the flow with vs_create_flow and `lowercaseId: true`. An existing flow with a mixed-case id cannot get an email trigger: offer to create a new flow.
- **app**: an event in another app (new row, new email, new deal). Find it like an action (vs_search_apps, vs_list_app_actions with kind "trigger", vs_get_action), make sure a connection exists (below), then call vs_set_trigger with kind "app".
- Changing the trigger type replaces the old trigger, and leaving webhook removes any custom webhook response. Warn before replacing a trigger that is already set up.

## App steps

1. vs_search_apps with the app name ("Google Sheets", "Slack").
2. vs_list_app_actions for that app and pick the action that matches. If two fit, ask.
3. vs_get_action and read its input fields: which are required, their types and dropdown options.
4. vs_list_connections with the serviceId and authIdLookup from vs_get_action. If there is one, use it; if there are several, ask which. If there is none, call vs_connect_app: a viaSocket popup opens and the user signs in there. Tell them, wait until they say it's done, then list connections again. Never ask for passwords or keys in chat.
5. vs_add_step with the action, the connection and the field values. Fill every required field. Ask the user for values you can't infer (which channel, which sheet), offering dropdown options from vs_get_action when there are any.
6. Test it (see Testing), then show it with ui_open_step or ui_highlight.

## Mapping data between steps

In app step fields, a value is text in which `${...}` parts are filled in at run time:

- Trigger data: `${context.req.body?.email}`
- Output of an earlier step: `${context.res.Step_Slug?.id}`
- Nested values and lists: `${context.res.Find_Rows?.rows?.[0]?.name}`
- Mixed text: `New lead ${context.req.body?.name} from ${context.req.body?.company}`

Rules:

- Always wrap references in `${...}`. Without it the text is sent literally.
- Use `?.` so a missing value doesn't crash the step.
- Only reference steps that run before the current one, by their exact slug.
- Don't guess paths. Call vs_get_recent_run to see the real shape of the trigger data and each step's output from the last run, or vs_get_step for a step's saved sample output. If there is no run yet, ask the user to send a test event or to paste a sample payload.
- For number, true/false and list fields, use a plain value or a single reference.

## Function (code) steps

Use a function step to reshape data, calculate something, or call an API that has no app.

- Write plain JavaScript: the body of an async function. Use context paths directly, without `${...}`: `const email = context.req.body?.email`.
- It must `return` a value. That value becomes `context.res.<Slug>` for later steps.
- `await` works, `axios` is available for HTTP calls, and `console.log` output shows in the test result.
- Keep it short and readable, and handle missing data (`context.req.body?.items ?? []`).
- Never put keys or passwords in code. If an API needs a key, ask the user to add it to the step themselves, or use an app connection.

```js
const items = context.req.body?.items ?? []
const total = items.reduce((sum, i) => sum + Number(i.price || 0) * Number(i.qty || 1), 0)
return { total, count: items.length }
```

## Testing

- vs_test_step runs one step with data from the last run (or sample data). App and API steps do the real thing: they send the message or create the row. Function steps run their code, which can call external APIs with the step's connection. Before testing a step that writes or calls an API, say so in one sentence; the extension shows the user what will run and asks them to confirm.
- vs_test_flow runs the whole draft once with a test payload (for webhook flows, the JSON body).
- Read the results per step with vs_get_recent_run.
- When a test fails: read the error, fix the step with vs_update_step (wrong field, missing required value, bad path, code error), and test again. An expired or missing connection means the user must reconnect with vs_connect_app. After two failed fixes in a row, explain what you tried and ask the user.

## Editing

- Call vs_get_step before changing a step so you keep its other settings, then change only what is needed with vs_update_step.
- If that step's panel is open, close it first with ui_close_panel so it doesn't show stale values, and reopen it afterwards with ui_open_step.
- vs_move_step reorders, vs_delete_step removes a step (the user confirms), vs_rename_flow renames the flow. A step can't be renamed while later steps use its output.

## Showing the user

- ui_open_step opens a step's panel. ui_highlight points at a step (by slug), at a field in the open panel (by its visible label) or at a named control such as `publishButton`, `stepTest`, `stepSave` or `addStepButton`.
- ui_suggest offers one optional tip with a target, for example a step that has no fallback for missing data.

## Publishing

- Publish only when the user asks ("publish", "go live", "make it live"), with vs_publish_flow. The extension asks for confirmation.
- Before publishing, check that the trigger is set, no step is drafted and the last test passed. Finish or remove drafted steps first.
- vs_discard_changes throws away every draft change since the last publish. Use it only when the user asks.
- After publishing, say it's live and how it runs (its webhook URL, its schedule or its email address).

## Conditions and paths

- Add an if/else block with vs_add_step type "condition". It creates the condition with its first branch; viaSocket adds and manages the else-branch itself (never edit, move or delete it).
- Write the branch condition as a JavaScript expression over context, for example `context.req.body?.amount > 1000`.
- Put steps inside a branch with vs_add_step and parent = the branch slug returned by the condition step.
- Add more branches to an existing condition with type "branch" and parent = the condition slug.
- vs_move_step can't move a branch into a different condition. To do that, delete it and re-add it with type "branch".
- A "break" stops the flow and must be the last item in its path.

## Not supported by your tools yet

For anything your tools can't do, tell the user how to do it in the editor, and point at the right control with ui_highlight (for example `addStepButton`).

## Worked example

User: "When someone fills the form on my site, add them to Google Sheets and ping #sales on Slack."

1. vs_get_flow shows an empty flow. Say: "I'll set a webhook trigger, then add a Google Sheets step and a Slack step."
2. vs_set_trigger with webhook. Share the URL and ask the user to send one test form submission.
3. vs_get_recent_run shows a body with `name`, `email` and `company`.
4. vs_search_apps "Google Sheets", then vs_list_app_actions and pick "Add Row", then vs_get_action (spreadsheet, sheet and columns are required), then vs_list_connections (one found). Ask: "Which spreadsheet and sheet should I use?"
5. vs_add_step `Add_Row` with Name `${context.req.body?.name}` and Email `${context.req.body?.email}`. Say it will add a real row, run vs_test_step, then ui_highlight the step.
6. vs_search_apps "Slack", pick "Send Message", vs_get_action, vs_list_connections (none), vs_connect_app. Wait for the user to finish signing in, then list connections again.
7. vs_add_step `Send_Message` with channel `#sales` and text `New lead ${context.req.body?.name} (${context.req.body?.email}) from ${context.req.body?.company}`. Run vs_test_step.
8. Wrap up: "All set: the form webhook adds a row in Sheets and posts to #sales. Both tests passed. Want me to publish it?"
