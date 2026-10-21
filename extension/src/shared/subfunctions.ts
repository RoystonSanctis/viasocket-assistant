// Message protocol for the JS step "Subfunctions & Actions" panel (content/subfunctions-ui.ts) and its
// background handler (background/subfunctions.ts). The panel never talks to the viaSocket API itself: every read
// and write goes through the worker's ViaSocketClient (env-named cookie, allowlisted host, per-flow write queue).

/** One entry of a function step's `subfunctions`, exactly as the backend stores it. */
export interface SubfunctionRef {
  /** JS identifier the step code calls: `await <name>({ inputData: {...} })` */
  name: string
  /** Developer Hub action rowid */
  actionId: string
  /** Connection id, or 'NoAuth' for actions that need none */
  authId: string
}

export const NO_AUTH_ID = 'NoAuth'

export interface SubfnApp {
  serviceId: string
  name: string
  description?: string
  domain?: string
}

export interface SubfnAction {
  actionId: string
  name: string
  description?: string
  category?: string
  subCategory?: string
  serviceId?: string
  appName?: string
  iconUrl?: string
  authIdLookup?: string
  actionVersionId?: string
  needsConnection: boolean
}

export interface SubfnActionDetail extends SubfnAction {
  /** The action's inputs as the step panel lays them out (order, groups, dependencies, visibility) */
  form: SubfnForm
}

/** One input of an action, as the step panel knows it. Never carries the app's own code. */
export interface SubfnFieldSpec {
  /** Full key: a field of an input group is `group["child"]` */
  key: string
  label?: string
  /** Lower-cased editor type: string, number, boolean, dropdown, multiselect, dictionary, input groups, … */
  type: string
  required?: boolean
  list?: boolean
  help?: string
  placeholder?: string
  /** Fixed choices */
  options?: Array<{ label: string; value: unknown }>
  /** Choices come from the app: load them with subfn:field-options */
  dynamic?: boolean
  /** The app searches its choices by text (enableSearchApi) */
  searchable?: boolean
  /** An input group whose fields the app generates: load them with subfn:group-fields */
  generates?: boolean
  /** Fields that must have a value before this one is shown (and its choices or fields can load) */
  dependsOn?: string[]
  /** visibilityCondition: a JavaScript expression over context.inputData, evaluated with shared/field-rules */
  visibleWhen?: string
  defaultValue?: unknown
  /** Date fields: the format the action wants the date as text in (otherwise it reads a Date object) */
  dateFormat?: string
}

/** Inputs in panel order: steps[location] lists the keys shown there ('root', or a group's key). */
export interface SubfnForm {
  steps: Record<string, string[]>
  fields: Record<string, SubfnFieldSpec>
}

export interface SubfnOptionsResult {
  options: Array<{ label: string; value: unknown }>
  more?: boolean
  help?: string
  /** Fields to fill before the choices can load */
  needsFirst?: string[]
  needsConnection?: boolean
  error?: string
}

export interface SubfnGroupResult {
  form?: SubfnForm
  needsFirst?: string[]
  needsConnection?: boolean
  error?: string
}

export interface SubfnConnection {
  id: string
  label?: string
  valid: boolean
}

export type SubfnRequest =
  | { target: 'background'; type: 'subfn:search-apps'; query: string }
  | { target: 'background'; type: 'subfn:list-actions'; serviceId: string }
  | { target: 'background'; type: 'subfn:get-action'; actionId: string }
  | { target: 'background'; type: 'subfn:list-connections'; serviceId: string; authIdLookup: string }
  | { target: 'background'; type: 'subfn:connect'; serviceId: string; authIdLookup: string; actionVersionId?: string }
  /** Choices of a dynamic field, loaded by the app with the connection and the values filled so far */
  | {
      target: 'background'
      type: 'subfn:field-options'
      actionId: string
      fieldKey: string
      authId: string
      /** Plain values by field key (a group field is `group["child"]`) */
      values: Record<string, unknown>
      search?: string
    }
  /** Fields of an input group that the app generates */
  | { target: 'background'; type: 'subfn:group-fields'; actionId: string; groupKey: string; authId: string; values: Record<string, unknown> }
  | {
      target: 'background'
      type: 'subfn:save'
      scriptId: string
      stepId: string
      slugName: string
      code: string
      subfunctions: SubfunctionRef[]
      /** Input Values as the panel shows them; when absent the saved ones are kept */
      dynamicVariables?: Record<string, string>
    }

export type SubfnResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

/** Subfunction names become JS function declarations the backend prepends to the step code. */
export const SUBFUNCTION_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
/** viaSocket row ids (apps, actions, auth versions, connections) */
export const ROW_ID_RE = /^[A-Za-z0-9_]{4,40}$/
