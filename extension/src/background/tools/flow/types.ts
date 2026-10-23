// Shapes of the viaSocket flow data the tools read. Only the fields the tools use are typed; everything else is
// carried through untouched (the backend stores client keys verbatim, so dropping them would lose data).

export type StepStatus = 'DRAFTED' | 'ACTIVE' | 'INACTIVE' | 'DELETE'

export interface FieldDef {
  key?: string
  label?: string
  type?: string
  required?: boolean
  list?: boolean
  help?: string
  placeholder?: string
  defaultValue?: unknown
  children?: Array<{ label?: unknown; value?: unknown }>
  source?: string
  dependsOn?: string[]
  visibilityCondition?: string
  [k: string]: unknown
}

export interface InputJson {
  steps: Record<string, string[]>
  blocks: Record<string, FieldDef>
}

export interface AuthData {
  id?: string
  type?: string
  connection_label?: string
  [k: string]: unknown
}

export interface SelectedValues {
  authData?: AuthData
  inputData?: Record<string, unknown>
  [k: string]: unknown
}

/** pluginData: block.metaData while DRAFTED, the parsed functions.code once saved, or a drafted app trigger */
export interface PluginData {
  serviceId?: string
  serviceName?: string
  actionName?: string
  actionVersionId?: string
  selectedCreate?: string
  authIdLookup?: string
  authType?: string
  iconUrl?: string
  inputJson?: InputJson
  selectedValues?: SelectedValues
  triggerType?: string
  isDrafted?: boolean
  [k: string]: unknown
}

export interface Block {
  type: string
  identifier?: string
  status?: StepStatus | string
  parent?: string
  description?: string
  iconUrl?: string
  draftStatus?: string
  sampleData?: unknown
  metaData?: PluginData
  service?: { serviceId?: string; eventId?: string; actionVersionId?: string; authVersionId?: string }
  condition?: string
  statement?: string
  html?: string
  data?: string
  isElseBlock?: boolean
  responseType?: string
  metadata?: unknown
  subfunctions?: unknown
  mode?: string
  [k: string]: unknown
}

export interface Trigger extends PluginData {
  type?: string
  cronExpression?: string
  meaning?: string
  timezone?: string
}

export interface JsonScript {
  identifier?: string
  title?: string
  version?: string
  trigger?: Trigger
  order: Record<string, string[]>
  blocks: Record<string, Block>
}

export interface FlowRow {
  id: string
  title?: string
  project_id?: string
  org_id?: string | number
  status?: string
  json_script: JsonScript
  published_json_script?: JsonScript
  /** AIFlow: built in viaSocket's English (AI) mode, shown as a Summary and Flow view instead of the canvas */
  metadata?: { description?: string; AIFlow?: boolean; [k: string]: unknown }
  [k: string]: unknown
}

export interface FunctionRow {
  id: string
  type?: string
  title?: string
  /** Draft code: the function body, or a JSON string for api and plugin steps */
  code?: string
  auth_id?: string | null
  action_id?: string | null
  action_version_id?: string | null
  metadata?: { drafted?: { dynamicVariables?: Record<string, unknown> } }
}

export interface FlowTarget {
  orgId: string
  projectId: string
  scriptId: string
}
