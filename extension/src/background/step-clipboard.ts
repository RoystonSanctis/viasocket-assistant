// Background handler for step copy and paste operations across flows, workspaces, and accounts.

import {
  COPIED_STEP_STORAGE_KEY,
  type CopiedStepBlock,
  type CopiedStepData,
  type CopiedStepFunctionData,
  type StepClipboardRequest,
  type StepClipboardResponse,
} from '../shared/step-clipboard'
import { parsePage, type PageContext } from '../shared/page'
import { resolveEnv } from './tools/env'
import { ViaSocketClient } from './tools/viasocket-client'
import { SCRIPT_ID_RE } from './tools/ids'
import { normalizeFlow, slugForStepId } from './tools/flow/flow-api'
import { isValidSlug, stepSlug } from './tools/flow/slugs'
import {
  apiBody, breakBody, functionBody, pluginBody, variableBody, type SaveCommon,
} from './tools/flow/step-bodies'
import type { AuthData, PluginData } from './tools/flow/types'
import { asRecord, isRecord, parseMaybeJson, prefixedStepId, PROJECT_ID_RE, str } from './tools/flow/util'
import { getSession } from './agent/session'

/**
 * A viaSocket client for the tab a clipboard or transfer message came from: the tab's assistant session client
 * when one exists (right cookie store and environment), otherwise one built from the tab's own URL plus whatever
 * the message said about the target.
 */
export async function getClientForSender(
  sender: chrome.runtime.MessageSender,
  fallbackTarget?: { scriptId?: string; projectId?: string; orgId?: string; host?: string },
): Promise<ViaSocketClient | null> {
  const tabId = sender.tab?.id
  if (tabId !== undefined) {
    const session = getSession(tabId)
    if (session?.vs && session.page) return session.vs
  }

  const tab = sender.tab
  const tabUrl = tab?.url || ''
  let host = fallbackTarget?.host || ''
  if (!host) {
    // No named target and no parsable tab URL: refuse rather than defaulting to some host.
    try {
      host = new URL(tabUrl).host
    } catch {
      return null
    }
  }

  const env = resolveEnv(host)
  if (!env) return null

  const page: PageContext = parsePage(tabUrl || `https://${host}`)
  if (fallbackTarget?.scriptId) page.scriptId = fallbackTarget.scriptId
  if (fallbackTarget?.projectId) page.projectId = fallbackTarget.projectId
  if (fallbackTarget?.orgId) page.orgId = fallbackTarget.orgId

  const stores = await chrome.cookies.getAllCookieStores().catch(() => [])
  const storeId = stores.find((s) => tabId !== undefined && s.tabIds.includes(tabId))?.id
  return new ViaSocketClient(env, page, { storeId, incognito: tab?.incognito })
}

export async function handleStepClipboardRequest(
  req: StepClipboardRequest,
  sender: chrome.runtime.MessageSender,
): Promise<StepClipboardResponse> {
  switch (req.type) {
    case 'step:get-copied': {
      try {
        const store = await chrome.storage.local.get(COPIED_STEP_STORAGE_KEY)
        return { ok: true, data: store[COPIED_STEP_STORAGE_KEY] || null }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to read clipboard' }
      }
    }

    case 'step:copy': {
      try {
        const client = await getClientForSender(sender, {
          scriptId: req.scriptId,
          projectId: req.projectId,
          orgId: req.orgId,
          host: req.host,
        })
        if (!client) return { ok: false, error: 'Could not connect to viaSocket for this page' }

        const scriptId = req.scriptId || client.page.scriptId
        const projectId = req.projectId || client.page.projectId
        if (!scriptId || !projectId) {
          return { ok: false, error: 'No flow is open in this tab' }
        }
        if (!SCRIPT_ID_RE.test(scriptId) || !PROJECT_ID_RE.test(projectId)) {
          return { ok: false, error: 'This page does not look like a viaSocket flow' }
        }

        // The copied block always comes from the server read; a failed read surfaces as the copy error.
        let block: CopiedStepBlock | null = null
        const flowRes = await client.request<{ success: boolean; data: any }>({
          method: 'GET',
          path: `/projects/${projectId}/scripts/${scriptId}`,
          query: { type: 'flow' },
        })
        const row = flowRes?.data || flowRes
        const jsonScript = row?.json_script
        if (jsonScript?.blocks && typeof jsonScript.blocks === 'object') {
          block = jsonScript.blocks[req.slugName] || null
        }

        if (!block) {
          return { ok: false, error: `Step "${req.slugName}" was not found in this flow` }
        }

        // Read function row if this is a code/plugin/api/function step
        let functionData: CopiedStepFunctionData | undefined = undefined
        const funcId = block.identifier
        if (funcId && typeof funcId === 'string' && (block.type === 'plugin' || block.type === 'function' || block.type === 'api')) {
          try {
            const fnRes = await client.request<{ success: boolean; data: any }>({
              method: 'GET',
              path: `/scripts/${scriptId}/functions/${encodeURIComponent(funcId)}`,
            })
            const fnRow = fnRes?.data || fnRes
            if (fnRow && typeof fnRow === 'object') {
              // Dynamic variables live under the row's metadata.drafted, not at its top level.
              const drafted = asRecord(asRecord(fnRow.metadata).drafted)
              functionData = {
                code: typeof fnRow.code === 'string' ? fnRow.code : fnRow.code ? JSON.stringify(fnRow.code) : undefined,
                dynamicVariables: isRecord(drafted.dynamicVariables) ? drafted.dynamicVariables : undefined,
                subfunctions: fnRow.subfunctions ?? block.subfunctions,
                auth_id: fnRow.auth_id,
                action_id: fnRow.action_id,
              }
            }
          } catch (e) {
            console.warn('[step-clipboard] could not read function details:', e)
          }
        }

        const stepTitle = String(block.title || req.slugName)
        const copied: CopiedStepData = {
          version: 1,
          copiedAt: Date.now(),
          source: {
            host: client.page.host || 'beta-flow.viasocket.com',
            orgId: req.orgId || client.page.orgId,
            projectId,
            scriptId,
            slugName: req.slugName,
            stepTitle,
            type: String(block.type || 'plugin'),
          },
          block,
          functionData,
        }

        await chrome.storage.local.set({ [COPIED_STEP_STORAGE_KEY]: copied })
        return {
          ok: true,
          data: {
            stepTitle,
            type: copied.source.type,
            slugName: req.slugName,
            copied,
          },
        }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to copy' }
      }
    }

    case 'step:paste': {
      try {
        const store = await chrome.storage.local.get(COPIED_STEP_STORAGE_KEY)
        const copied = store[COPIED_STEP_STORAGE_KEY] as CopiedStepData | undefined
        if (!copied || !copied.block) {
          return { ok: false, error: 'No active copy. Please copy first.' }
        }

        const client = await getClientForSender(sender, {
          scriptId: req.scriptId,
          projectId: req.projectId,
          orgId: req.orgId,
          host: req.host,
        })
        if (!client) return { ok: false, error: 'Could not connect to viaSocket for this page' }

        const scriptId = req.scriptId || client.page.scriptId
        const projectId = req.projectId || client.page.projectId
        if (!scriptId || !projectId) {
          return { ok: false, error: 'No destination flow open in this tab' }
        }
        if (!SCRIPT_ID_RE.test(scriptId) || !PROJECT_ID_RE.test(projectId)) {
          return { ok: false, error: 'This page does not look like a viaSocket flow' }
        }

        // The copied app config, parsed once: the saved code row when there is one, the draft block otherwise.
        const type = String(copied.block.type || 'plugin')
        const parsedCode = copied.functionData?.code ? parseMaybeJson(copied.functionData.code) : undefined
        const pluginData: PluginData | undefined =
          type === 'plugin'
            ? isRecord(parsedCode)
              ? (parsedCode as PluginData)
              : isRecord(copied.block.metaData)
                ? (copied.block.metaData as PluginData)
                : undefined
            : undefined
        if (type === 'plugin') {
          // The create route needs the catalog action id, which the saved config carries as selectedCreate.
          const actionId = str(pluginData?.selectedCreate) ?? str(copied.functionData?.action_id)
          if (!actionId) return { ok: false, error: 'This copied app step is missing its action id. Copy it again.' }
        }

        // The whole read-create-save sequence runs in the flow's write queue: the server rewrites the entire flow
        // JSON per request, so interleaving with other writers would silently lose steps. The token's active org is
        // aligned first, because step routes write in whatever org the token last touched.
        const data = await client.mutate(scriptId, async () => {
          if (client.orgId) await client.alignOrg(undefined, { force: true })

          // Fetch target flow to calculate position and ensure unique slug
          const targetFlowRes = await client.request<{ success: boolean; data: any }>({
            method: 'GET',
            path: `/projects/${projectId}/scripts/${scriptId}`,
            query: { type: 'flow' },
          })
          const targetRow = targetFlowRes?.data || targetFlowRes
          const jsonScript = targetRow?.json_script
          if (!jsonScript || !jsonScript.blocks) {
            throw new Error('Failed to read destination flow layout')
          }

          // Calculate insertion parent and position
          // Position is the index AFTER which the server inserts (it splices at position + 1), so position = idx
          // puts the new step immediately below targetSlugName.
          const order = jsonScript.order || {}
          let parentKey = 'root'
          let insertPosition: number | undefined = undefined

          for (const [key, list] of Object.entries(order)) {
            if (Array.isArray(list)) {
              const idx = list.indexOf(req.targetSlugName)
              if (idx !== -1) {
                parentKey = key
                insertPosition = idx
                break
              }
            }
          }

          // Comments live under root only (the editor never places them inside a condition branch), and the
          // server refuses or misplaces a comment created elsewhere - so a comment is appended at top level.
          if (type === 'comment') {
            parentKey = 'root'
            insertPosition = undefined
          }

          // Generate a non-conflicting, valid step name (names become identifiers in the generated flow code,
          // so the editor's own slug rules apply: 4-50 chars, no reserved words)
          const rawBase = copied.source.slugName || copied.source.stepTitle || 'Step'
          const baseSlug = isValidSlug(rawBase) ? rawBase : stepSlug(rawBase)
          const existingBlocks = jsonScript.blocks || {}
          let newSlug = baseSlug
          if (newSlug in existingBlocks) {
            const match = baseSlug.match(/^(.*?)_(\d+)$/)
            const prefix = match ? match[1] : baseSlug
            let counter = match && match[2] ? parseInt(match[2], 10) + 1 : 1
            while (`${prefix}_${counter}` in existingBlocks) {
              counter++
            }
            newSlug = `${prefix}_${counter}`
          }

          // Generate 12-char unique stepId with proper prefix
          const idPrefix: 'func' | 'vari' | 'ifcb' | 'swtc' | 'cmnt' | 'btkc' =
            type === 'variable'
              ? 'vari'
              : type === 'comment'
                ? 'cmnt'
                : type === 'break'
                  ? 'btkc'
                  : type === 'ifBlock' || type === 'branch'
                    ? 'ifcb'
                    : type === 'condition' || type === 'ifGroup'
                      ? 'swtc'
                      : 'func'
          const newStepId = prefixedStepId(idPrefix)
          const postType = type === 'condition' ? 'ifGroup' : type === 'branch' ? 'ifBlock' : type
          // Condition groups and comments keep their key equal to their stepId; everything else keeps its name.
          const keyIsId = postType === 'ifGroup' || postType === 'comment'

          // Assemble POST stepv2 body
          const postBody: Record<string, unknown> = {
            type: postType,
            title: keyIsId ? newStepId : newSlug,
            stepId: newStepId,
            orderGroup: parentKey,
          }
          if (insertPosition !== undefined) {
            postBody.position = insertPosition
          }
          if (copied.block.description) postBody.description = copied.block.description
          if (copied.block.iconUrl) postBody.iconUrl = copied.block.iconUrl

          if (type === 'plugin') {
            postBody.actionId = str(pluginData?.selectedCreate) ?? str(copied.functionData?.action_id)
          } else if (type === 'variable') {
            // data/html are saved by the follow-up PUT
          } else if (type === 'comment') {
            postBody.data = copied.block.data ?? ''
            if (isRecord(copied.block.metadata)) postBody.metadata = copied.block.metadata
          } else if (type === 'break') {
            postBody.data = ''
            postBody._data = ''
          } else if (postType === 'ifBlock') {
            postBody.condition = copied.block.condition ?? ''
            postBody.html = copied.block.html ?? ''
            postBody.statement = copied.block.statement ?? ''
          } else if (postType === 'ifGroup') {
            // A condition group is only valid with a first branch; the server then maintains the else branch.
            postBody.stepChildDetails = { type: 'ifBlock', title: prefixedStepId('ifcb'), orderGroup: newStepId, stepId: prefixedStepId('ifcb') }
          }

          // POST stepv2 (live: true sends the live-apply header so the open editor updates its canvas in place)
          const createRes = await client.request({
            method: 'POST',
            path: `/scripts/${projectId}/${scriptId}/stepv2`,
            body: postBody,
            live: true,
          })
          // The server de-duplicates names silently, so the slug it stored is read back, never assumed.
          const createdJs = normalizeFlow(asRecord(createRes).script)?.json_script
          const actualSlug = (createdJs ? slugForStepId(createdJs, newStepId) : undefined) ?? (keyIsId ? newStepId : newSlug)
          const createdBlock = createdJs?.blocks[actualSlug]

          // Now save step details/code via PUT stepv2
          let putSuccess = false
          let putNote: string | undefined = undefined
          const common: SaveCommon = {
            stepId: newStepId,
            title: actualSlug,
            description: copied.block.description,
            sampleData: copied.block.sampleData,
            iconUrl: copied.block.iconUrl,
          }

          const putStep = async (body: Record<string, unknown>) => {
            await client.request({
              method: 'PUT',
              path: `/scripts/${scriptId}/stepv2/${encodeURIComponent(actualSlug)}`,
              body,
              live: true,
            })
            putSuccess = true
          }

          if (type === 'plugin' && pluginData && isRecord(parsedCode)) {
            try {
              let authData = asRecord(asRecord(pluginData.selectedValues).authData) as AuthData
              if (!str(authData.id) && copied.functionData?.auth_id) authData = { ...authData, id: copied.functionData.auth_id }
              if (authData.hidden === true) {
                // Built-in tools (agents, run-a-flow) use a per-workspace hidden connection that the create
                // attaches; the copied one belongs to the source workspace.
                const fresh = asRecord(asRecord(asRecord(createdBlock?.metaData).selectedValues).authData)
                if (str(fresh.id)) authData = fresh as AuthData
              }
              const inputData = asRecord(asRecord(pluginData.selectedValues).inputData)
              await putStep(pluginBody(common, pluginData, authData, inputData))
            } catch (err: any) {
              console.warn('[step-clipboard] PUT stepv2 auth/validation issue (expected across accounts):', err)
              putNote = 'Pasted as draft. Select your connection in this account to activate.'
            }
          } else if (type === 'plugin') {
            putNote = 'Pasted as draft. Finish its setup in the step panel.'
          } else if (type === 'function') {
            try {
              await putStep(
                functionBody(common, copied.functionData?.code ?? '', {
                  dynamicVariables: copied.functionData?.dynamicVariables,
                  authId: copied.functionData?.auth_id,
                  subfunctions: copied.block.subfunctions ?? copied.functionData?.subfunctions,
                }),
              )
            } catch (err) {
              console.warn('[step-clipboard] PUT function error:', err)
            }
          } else if (type === 'api') {
            try {
              if (isRecord(parsedCode)) {
                await putStep(
                  apiBody(common, parsedCode, {
                    dynamicVariables: copied.functionData?.dynamicVariables,
                    authId: copied.functionData?.auth_id,
                  }),
                )
              } else {
                putNote = 'Pasted as draft. The copied API step had no saved configuration.'
              }
            } catch (err) {
              console.warn('[step-clipboard] PUT api error:', err)
            }
          } else if (type === 'variable') {
            try {
              const body = variableBody(common, String(copied.block.data ?? ''))
              // Keep the editor's rich markup for the expression when the copy has it.
              if (str(copied.block.html)) body.html = copied.block.html
              await putStep(body)
            } catch (err) {
              console.warn('[step-clipboard] PUT variable error:', err)
            }
          } else if (type === 'break' && (str(copied.block.data) || str(copied.block.mode))) {
            try {
              await putStep(breakBody(common, String(copied.block.data ?? ''), copied.block.mode))
            } catch (err) {
              console.warn('[step-clipboard] PUT break error:', err)
            }
          } else {
            // comments, empty breaks and condition groups are complete after the create
            putSuccess = true
          }

          return {
            slug: actualSlug,
            title: actualSlug,
            stepId: newStepId,
            status: putSuccess ? 'active' : 'draft',
            note: putNote || (putSuccess ? 'Step pasted and activated!' : 'Step pasted as draft!'),
          }
        })

        return { ok: true, data }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to paste' }
      }
    }

    case 'step:delete': {
      try {
        const client = await getClientForSender(sender, {
          scriptId: req.scriptId,
          projectId: req.projectId,
          orgId: req.orgId,
          host: req.host,
        })
        if (!client) return { ok: false, error: 'Could not connect to viaSocket for this page' }

        const scriptId = req.scriptId || client.page.scriptId
        const projectId = req.projectId || client.page.projectId
        if (!scriptId || !projectId) {
          return { ok: false, error: 'No flow is open in this tab' }
        }
        if (!SCRIPT_ID_RE.test(scriptId) || !PROJECT_ID_RE.test(projectId)) {
          return { ok: false, error: 'This page does not look like a viaSocket flow' }
        }

        const data = await client.mutate(scriptId, async () => {
          if (client.orgId) await client.alignOrg(undefined, { force: true })

          const flowRes = await client.request<{ success: boolean; data: any }>({
            method: 'GET',
            path: `/projects/${projectId}/scripts/${scriptId}`,
            query: { type: 'flow' },
          })
          const row = flowRes?.data || flowRes
          const jsonScript = row?.json_script
          if (!jsonScript || !jsonScript.blocks) {
            throw new Error('Failed to read flow layout')
          }

          const block = jsonScript.blocks[req.slugName]
          if (!block) {
            throw new Error(`Step "${req.slugName}" was not found in this flow`)
          }
          if (req.slugName === 'response') {
            throw new Error('The webhook response cannot be deleted')
          }
          if (block.type === 'ifGroup') {
            throw new Error('A condition cannot be deleted directly; delete its branches')
          }
          if (block.isElseBlock) {
            throw new Error('The else-branch is managed by viaSocket and cannot be deleted')
          }
          if (block.status === 'DELETE') {
            return { slugName: req.slugName, title: String(block.title || req.slugName), note: 'It was already deleted' }
          }

          const softDeleteTypes = new Set(['api', 'function', 'plugin', 'variable', 'ifBlock'])
          const needsTitle = block.status !== 'DRAFTED' && softDeleteTypes.has(String(block.type))
          let body: { title: string } | undefined = undefined
          if (needsTitle) {
            const base = `${req.slugName}_DELETED`
            let title = base
            if (jsonScript.blocks[title]) {
              for (let i = 1; i < 1000; i++) {
                if (!jsonScript.blocks[`${base}_${i}`]) {
                  title = `${base}_${i}`
                  break
                }
              }
            }
            body = { title }
          }

          await client.request({
            method: 'DELETE',
            path: `/scripts/${scriptId}/stepv2/${encodeURIComponent(req.slugName)}`,
            body,
            live: true,
          })

          return {
            slugName: req.slugName,
            title: String(block.title || req.slugName),
          }
        })

        return { ok: true, data }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to delete' }
      }
    }
  }
}
