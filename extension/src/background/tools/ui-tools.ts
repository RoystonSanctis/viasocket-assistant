// UI tools: open and close step panels, point at things, suggest changes, refresh and navigate inside the app.
// They never call write APIs. Navigation targets are built from validated ids, never taken from the model as URLs,
// and highlight targets are named selector keys or visible labels, never raw CSS.

import type { HighlightTarget, Suggestion } from '../../shared/mascot'
import type { Tool, ToolContext } from './types'
import { DH_TOOLS } from './dh-tools'
import { FLOW_TOOLS } from './flow-tools'
import { ToolError } from './flow/errors'
import { editorParam, getFlow, requireOrg, resolveFlow, triggerKind, verifyProject } from './flow/flow-api'
import { knownFlowProject } from './flow/known'
import { SUGGESTABLE_TOOLS } from './flow/names'
import { defineTool, params, S, validateArgs } from './flow/schema'
import { appPath, DH_SECTION_KEYS, pagePathWithParams, type AppTarget, type DhSectionKey } from './flow/urls'
import { label, PROJECT_ID_RE, SLUG_RE } from './flow/util'

/** selectors.json keys the model may point at (stepNode is a template and is reached through slugName). */
const ELEMENT_KEYS = [
  'canvasViewport', 'zoomContainer', 'triggerNode', 'stepPanel', 'stepSave', 'stepTest', 'stepClose', 'addStepButton',
  'publishButton', 'discardButton', 'controls', 'askAiButton', 'zoomFitButton', 'navbar', 'section', 'saveButton',
  'dryRunButton', 'sidebar', 'tabs', 'shareButton',
] as const

const FIELD_LABEL = S.str('Visible label of a field in the open step panel or Developer Hub section, e.g. "Channel".', {
  minLength: 1,
  maxLength: 80,
})

function requireEditor(ctx: ToolContext): void {
  if (ctx.page.kind !== 'flow-editor') throw new ToolError('This only works in the flow editor. Open a flow first.')
}

function cleanText(v: string, max: number): string {
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

/** Panel query for the trigger: the editor keys trigger panels by trigger type. */
function triggerPanelSlug(kind: string | undefined): string {
  if (kind === 'webhook' || kind === 'email' || kind === 'cron') return kind
  return kind ? 'trigger' : 'selecttrigger'
}

const openStep = defineTool<{ slugName: string }>({
  name: 'ui_open_step',
  description:
    'Open the configuration panel of a step in the flow editor so the user can see it. Use "SET_TRIGGER" for the trigger panel and "response" for the webhook response. Use the slug from vs_get_flow.',
  parameters: params({ slugName: S.str('Step slug, "SET_TRIGGER" or "response".', { pattern: SLUG_RE.source }) }, ['slugName']),
  danger: 'safe',
  describe: (a) => `Opening ${a.slugName === 'SET_TRIGGER' ? 'the trigger' : label(a.slugName, 'the step')}`,
  async run(a, ctx) {
    requireEditor(ctx)
    const t = resolveFlow(ctx)
    const js = (await getFlow(ctx, t)).json_script
    let stepId: string
    let slugName = a.slugName
    if (a.slugName === 'SET_TRIGGER' || (a.slugName === 'trigger' && !js.blocks.trigger)) {
      stepId = 'SET_TRIGGER'
      slugName = triggerPanelSlug(triggerKind(js.trigger))
    } else if (a.slugName === 'response') {
      if (!js.blocks.response) throw new ToolError('This flow has no webhook response.')
      stepId = 'response'
    } else {
      const block = js.blocks[a.slugName]
      if (!block?.identifier) throw new ToolError(`No step "${a.slugName}". Call vs_get_flow for the current slugs.`)
      if (block.type === 'ifGroup') {
        throw new ToolError(`A condition has no panel of its own; open one of its branches: ${(js.order[a.slugName] ?? []).join(', ')}.`)
      }
      stepId = block.identifier
    }
    ctx.ui.navigate(pagePathWithParams(ctx.page.url, { stepId, slugName }), { replace: true })
    return { opened: slugName }
  },
})

const closePanel = defineTool<Record<string, never>>({
  name: 'ui_close_panel',
  description: 'Close the step or trigger panel that is open in the flow editor.',
  parameters: params({}),
  danger: 'safe',
  describe: () => 'Closing the panel',
  async run(_a, ctx) {
    requireEditor(ctx)
    const stepId = editorParam(ctx, 'stepId')
    if (!stepId && !editorParam(ctx, 'slugName')) return { closed: false, note: 'No panel is open.' }
    const changes: Record<string, string | null> = { stepId: null, slugName: null }
    if (stepId === 'ADD_STEP') Object.assign(changes, { position: null, parent: null })
    ctx.ui.navigate(pagePathWithParams(ctx.page.url, changes), { replace: true })
    return { closed: true }
  },
})

interface HighlightArgs {
  slugName?: string
  fieldLabel?: string
  element?: (typeof ELEMENT_KEYS)[number]
  note?: string
}

function targetOf(a: { slugName?: string; fieldLabel?: string; element?: string }): HighlightTarget | undefined {
  if (a.slugName) return a.slugName === 'SET_TRIGGER' ? { selectorKey: 'triggerNode' } : { slugName: a.slugName }
  if (a.fieldLabel) return { fieldLabel: cleanText(a.fieldLabel, 80) }
  if (a.element) return { selectorKey: a.element }
  return undefined
}

const highlight = defineTool<HighlightArgs>({
  name: 'ui_highlight',
  description:
    'Point the mascot at something on the page and spotlight it, with an optional short note. Give exactly one target: slugName (a step on the canvas, "SET_TRIGGER" for the trigger), fieldLabel (a field in the open panel, by its visible label) or element (a named part of the page).',
  parameters: params({
    slugName: S.str('Step slug from vs_get_flow, or "SET_TRIGGER".', { pattern: SLUG_RE.source }),
    fieldLabel: FIELD_LABEL,
    element: S.enum(ELEMENT_KEYS, 'Named page element.'),
    note: S.str('Short note shown next to the target.', { maxLength: 140 }),
  }),
  danger: 'safe',
  describe: (a) => `Pointing at ${label(a.slugName ?? a.fieldLabel ?? a.element, 'it')}`,
  async run(a, ctx) {
    const count = [a.slugName, a.fieldLabel, a.element].filter(Boolean).length
    if (count !== 1) throw new ToolError('Give exactly one of slugName, fieldLabel or element.')
    const target = targetOf(a)
    if (!target) throw new ToolError('Nothing to highlight.')
    ctx.ui.highlight(target, a.note ? cleanText(a.note, 140) : undefined)
    return { highlighted: true }
  },
})

interface SuggestArgs {
  message: string
  slugName?: string
  fieldLabel?: string
  applyTool?: string
  applyArgs?: Record<string, unknown>
  applyLabel?: string
}

const suggest = defineTool<SuggestArgs>({
  name: 'ui_suggest',
  description:
    'Show the user a suggestion card, optionally anchored to a step or field. With applyTool + applyArgs the card gets an Apply button that runs that tool call (through the normal confirmation) only if the user clicks it. Use it for proactive improvements instead of changing things unasked.',
  parameters: params(
    {
      message: S.str('The suggestion, one or two short sentences.', { minLength: 1, maxLength: 280 }),
      slugName: S.str('Step the suggestion is about.', { pattern: SLUG_RE.source }),
      fieldLabel: FIELD_LABEL,
      applyTool: S.enum([...SUGGESTABLE_TOOLS], 'Tool to run when the user clicks Apply (never a ui_ tool).'),
      applyArgs: S.map('Arguments for applyTool, exactly as that tool expects them.'),
      applyLabel: S.str('Apply button label, e.g. "Fix it".', { maxLength: 24 }),
    },
    ['message'],
  ),
  danger: 'safe',
  describe: () => 'Making a suggestion',
  async run(a, ctx) {
    if (a.applyArgs && !a.applyTool) throw new ToolError('applyArgs needs applyTool.')
    let apply: Suggestion['apply']
    if (a.applyTool) {
      if (!SUGGESTABLE_TOOLS.has(a.applyTool)) throw new ToolError(`${a.applyTool} cannot be used in a suggestion.`)
      const args = a.applyArgs ?? {}
      if ((JSON.stringify(args) ?? '').length > 8000) throw new ToolError('applyArgs is too large.')
      const tool = [...FLOW_TOOLS, ...DH_TOOLS].find((t) => t.name === a.applyTool)
      const errs = tool ? validateArgs(tool.parameters, args) : []
      if (errs.length) throw new ToolError(`applyArgs do not fit ${a.applyTool}: ${errs.join('; ')}`)
      apply = { tool: a.applyTool, args, label: a.applyLabel ? cleanText(a.applyLabel, 24) : undefined }
    }
    const id = ctx.ui.suggest({
      message: cleanText(a.message, 280),
      mood: 'suggest',
      target: targetOf({ slugName: a.slugName, fieldLabel: a.fieldLabel }),
      apply,
    })
    return { shown: true, id, applyButton: !!apply }
  },
})

const refreshPage = defineTool<{ reason: string }>({
  name: 'ui_refresh_page',
  description:
    'Make the page show the latest saved data, e.g. after changes the editor did not pick up. In the flow editor this refetches the flow without a full reload. Elsewhere it is a full reload: the user confirms first (unsaved edits there would be lost), and the reload happens once you have finished replying, which ends this conversation turn. So call it last, after all other tools, and follow it only with a short final reply.',
  parameters: params({ reason: S.str('Why the page is refreshed (shown to the user).', { minLength: 1, maxLength: 120 }) }, ['reason']),
  danger: 'safe',
  describe: () => 'Refreshing the page',
  async run(a, ctx) {
    if (ctx.page.kind === 'flow-editor') {
      ctx.ui.navigate(pagePathWithParams(ctx.page.url, { timestamp: String(Date.now()) }), { replace: true })
      return { refreshed: true, mode: 'refetch' }
    }
    const reason = cleanText(a.reason, 120)
    const detail = `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Any unsaved edits on this page will be lost.`
    const ok = await ctx.ui.confirm('Reload this page?', detail, false, 'Reload')
    if (!ok) return { refreshed: false, note: 'The user chose not to reload. The page may show old data until they refresh it.' }
    // The reload replaces the page and its session, so it waits for the end of the run (see UiBridge.reloadPage).
    ctx.ui.reloadPage(reason)
    return {
      refreshed: false,
      reloadScheduled: true,
      mode: 'reload',
      note: 'The page reloads as soon as you finish this reply, and that ends the current run. Do not call more tools now; reply to the user in one short sentence. Anything else has to wait for their next request after the reload.',
    }
  },
})

interface NavigateArgs {
  to: 'flow' | 'project' | 'home' | 'dh-plugin' | 'dh-section'
  projectId?: string
  scriptId?: string
  pluginId?: string
  sectionKey?: DhSectionKey
  sectionId?: string
  versionId?: string
}

const ALNUM = '^[A-Za-z0-9]{1,40}$'

const navigate = defineTool<NavigateArgs>({
  name: 'ui_navigate',
  description:
    'Go to another page of viaSocket in the open workspace: a flow ("flow", scriptId from vs_list_flows), a project ("project"), the home page ("home"), a Developer Hub plugin ("dh-plugin", pluginId) or one of its sections ("dh-section", pluginId + sectionKey, optional sectionId and versionId).',
  parameters: params(
    {
      to: S.enum(['flow', 'project', 'home', 'dh-plugin', 'dh-section'], 'Destination.'),
      projectId: S.str('Project id (to "project").', { pattern: PROJECT_ID_RE.source }),
      scriptId: S.str('Flow id (to "flow").', { pattern: '^[A-Za-z0-9]{12}$' }),
      pluginId: S.str('Developer Hub plugin id.', { pattern: ALNUM }),
      sectionKey: S.enum(DH_SECTION_KEYS, 'Developer Hub section.'),
      sectionId: S.str('Id inside the section, e.g. an action id.', { pattern: ALNUM }),
      versionId: S.str('Action version id for action/trigger sections.', { pattern: ALNUM }),
    },
    ['to'],
  ),
  danger: 'safe',
  describe: (a) => `Going to ${a.to === 'flow' ? 'the flow' : a.to === 'home' ? 'home' : a.to.startsWith('dh') ? 'the Developer Hub' : 'the project'}`,
  async run(a, ctx) {
    const orgId = requireOrg(ctx)
    let target: AppTarget
    switch (a.to) {
      case 'flow': {
        if (!a.scriptId) throw new ToolError('scriptId is required.')
        const projectId = a.scriptId === ctx.page.scriptId ? ctx.page.projectId : knownFlowProject(orgId, a.scriptId)
        if (!projectId) throw new ToolError('Unknown flow. Use a scriptId from vs_list_flows or vs_create_flow.')
        target = { to: 'flow', orgId, projectId, scriptId: a.scriptId }
        break
      }
      case 'project':
        if (!a.projectId) throw new ToolError('projectId is required.')
        await verifyProject(ctx, orgId, a.projectId)
        target = { to: 'project', orgId, projectId: a.projectId }
        break
      case 'home':
        target = { to: 'home', orgId }
        break
      case 'dh-plugin':
        if (!a.pluginId) throw new ToolError('pluginId is required.')
        target = { to: 'dh-plugin', orgId, pluginId: a.pluginId }
        break
      case 'dh-section':
        if (!a.pluginId || !a.sectionKey) throw new ToolError('pluginId and sectionKey are required.')
        target = { to: 'dh-section', orgId, pluginId: a.pluginId, sectionKey: a.sectionKey, sectionId: a.sectionId, versionId: a.versionId }
        break
    }
    const path = appPath(target)
    ctx.ui.navigate(path)
    return { navigated: path }
  },
})

export const UI_TOOLS: Tool<any>[] = [openStep, closePanel, highlight, suggest, refreshPage, navigate]
