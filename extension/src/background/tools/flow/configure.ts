// The step panel's configure rules for an app step or an app trigger, shared by vs_set_trigger, vs_test_trigger,
// vs_add_step and vs_update_step. Given the values to save (held from earlier calls plus the new ones), it:
//   1. encodes them over the saved inputData,
//   2. loads the fields of input groups the app generates (once their parents and the connection are set),
//   3. fills visible empty fields that have a default, like the panel,
//   4. lists required fields that are still empty (and groups whose fields are not generated yet),
//   5. checks every dropdown value against the field's real choices (labels become values; guesses are refused),
//   6. records the picked options in inputJson so the panel shows their labels,
//   7. strips values of hidden fields, as the editor does before a save or a test.
// Nothing is written here; callers save only when the result is complete.

import type { ToolContext } from '../types'
import { normalizeInputJson } from './catalog'
import { ToolError } from './errors'
import {
  applyDefaults, checkChoices, cleanInputData, expandSourceGroups, missingInputs, withPickedOptions, type AppliedDefault, type NeedInput,
} from './fields'
import { encodeInputData } from './input-data'
import type { AuthData, FlowTarget, InputJson, PluginData } from './types'
import { asRecord, str } from './util'

export interface ConfigureInput {
  holdKey: string
  /** The step's or trigger's plugin data (inputJson, actionVersionId, dynamicInputRequired) */
  pd: PluginData
  /** Field values to save: held from earlier calls plus the ones given now (null clears a field) */
  values: Record<string, unknown>
  /** Keys given in this call (an input group whose parents changed reloads its fields) */
  changed: ReadonlySet<string>
  /** inputData the values are encoded over: the saved one, or {} when replacing / for a drafted trigger */
  base: Record<string, unknown>
  authData: AuthData | undefined
  isTrigger: boolean
  slug?: string
  /** Fields whose value the user typed themselves (free text in a dropdown, text meant literally) */
  customInput: ReadonlySet<string>
  /** No connection is shown for this step (NoAuth, manual webhook trigger) */
  noConnection: boolean
  /** Keys the runtime reads besides fields (hookUrl, scheduledTime) */
  extra?: Record<string, unknown>
}

export interface Configured {
  /** The values, with dropdown labels replaced by option values */
  values: Record<string, unknown>
  ij: InputJson
  /** pd.inputJson with generated fields and picked options merged in */
  inputJson: InputJson & Record<string, unknown>
  /** inputData with hidden fields stripped: what the editor saves and tests with */
  cleaned: Record<string, unknown>
  missing: { blocking: NeedInput[]; maybe: NeedInput[] }
  /** Required fields still empty, dropdowns whose choices must load first, then the may-be-required ones */
  needs: NeedInput[]
  defaultsApplied: AppliedDefault[]
  /** Dropdowns switched to the editor's manual input (data insert texts, or text the user typed) */
  dynamicInput: string[]
  warnings: string[]
  /** Connection set (or not needed) and nothing required missing: ready to test and save */
  complete: boolean
}

function fail(problems: string[]): never {
  throw new ToolError(`Nothing was changed. Fix these first: ${problems.join(' | ')}`)
}

export async function configure(ctx: ToolContext, t: FlowTarget, c: ConfigureInput): Promise<Configured> {
  const warnings: string[] = []
  const avid = str(c.pd.actionVersionId) ?? ''
  let ij = normalizeInputJson(c.pd.inputJson)
  let enc = encodeInputData(c.values, ij, c.base)
  if (enc.problems.length) fail(enc.problems)
  let inputData = { ...enc.inputData, ...(c.extra ?? {}) }
  const connected = !!c.authData?.id || c.noConnection

  if (connected) {
    const grown = await expandSourceGroups(ctx, t, {
      ij,
      authData: c.authData,
      inputData,
      actionVersionId: avid,
      isTrigger: c.isTrigger,
      slug: c.slug,
      noConnection: c.noConnection,
      holdKey: c.holdKey,
      changed: c.changed,
    })
    warnings.push(...grown.problems.map((p) => `Could not load generated fields: ${p}`))
    if (grown.expanded.length) {
      ij = grown.ij
      // Generated field keys only exist now: encode the values again so they are kept.
      enc = encodeInputData(c.values, ij, c.base)
      if (enc.problems.length) fail(enc.problems)
      inputData = { ...enc.inputData, ...(c.extra ?? {}) }
    }
  }
  if (enc.unknownKeys.length) warnings.push(`Ignored unknown fields: ${enc.unknownKeys.join(', ')}`)

  const defaults = applyDefaults(ij, inputData)
  ij = defaults.ij
  const missing = missingInputs(ij, inputData)
  let values = c.values
  const needs: NeedInput[] = [...missing.blocking]
  let dynamicInput: string[] = []
  let complete = connected && !missing.blocking.length

  if (complete) {
    const choices = await checkChoices(ctx, t, {
      ij,
      values,
      inputData,
      authData: c.authData,
      actionVersionId: avid,
      isTrigger: c.isTrigger,
      slug: c.slug,
      holdKey: c.holdKey,
      customInput: c.customInput,
      noConnection: c.noConnection,
    })
    if (choices.problems.length) fail(choices.problems)
    warnings.push(...choices.notes)
    if (choices.needsChoices.length) {
      needs.push(...choices.needsChoices)
      complete = false
    }
    const replaced: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(choices.values)) if (v !== values[k]) replaced[k] = v
    if (Object.keys(replaced).length) {
      values = choices.values
      Object.assign(inputData, encodeInputData(replaced, ij, inputData).inputData)
    }
    ij = withPickedOptions(ij, choices.picked, inputData)
    const mapped = Object.entries(values)
      .filter(([k, v]) => {
        const type = String(ij.blocks[k]?.type ?? '').toLowerCase()
        if (type !== 'dropdown' && type !== 'multiselect') return false
        return (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && x.includes('${'))
      })
      .map(([k]) => k)
    dynamicInput = [...new Set([...mapped, ...choices.customDropdowns])]
  }
  needs.push(...missing.maybe)
  return {
    values,
    ij,
    inputJson: { ...asRecord(c.pd.inputJson), steps: ij.steps, blocks: ij.blocks },
    cleaned: cleanInputData(inputData, ij),
    missing,
    needs,
    defaultsApplied: defaults.applied,
    dynamicInput,
    warnings,
    complete,
  }
}
