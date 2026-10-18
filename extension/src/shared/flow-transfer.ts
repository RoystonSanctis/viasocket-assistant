// Flow export / import ("transfer") between accounts and workspaces: the file format and message protocol.
//
// The export file carries the flow's structure (blocks, order, trigger with its Get Data / loop / run-if, response,
// and the per-step code rows) but never credentials: connections stay behind their auth_id references, which only
// resolve inside the workspace that owns them. Importing somewhere else recreates the structure and leaves steps
// whose connection is missing as drafts for the user to reconnect.
//
// Values the user typed into steps are a different matter: API headers and query params, dynamic-variable values,
// free-text field values and sample data are all part of the flow and are exported verbatim. The UI showing the
// export must repeat FLOW_EXPORT_NOTE so nobody shares the file believing it is free of pasted keys.

export const FLOW_EXPORT_VERSION = 1 as const

/** Import files larger than this are refused (a real flow export is a few hundred KB at most). */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024

/** Imports with more blocks than this are refused: each block is recreated with its own API calls. */
export const MAX_IMPORT_BLOCKS = 200

/** Written into every export file as `note`, and worth repeating in the export UI. */
export const FLOW_EXPORT_NOTE =
  'Connections are NOT included - steps only reference them, and those references resolve nowhere else. ' +
  'But every value typed into steps IS included verbatim: API headers and query params, dynamic variables, ' +
  'field values and sample data, including any keys pasted there. Share this file accordingly. ' +
  'Import it from the flow menu with the viaSocket assistant extension.'

export interface FlowExportSource {
  host: string
  orgId?: string
  projectId?: string
  scriptId: string
  title: string
  exportedAt: string
}

/** One step's own function row (code, mappings, references), keyed by the step's slug in the export. */
export interface ExportedFunction {
  type: string
  /**
   * The step's draft code exactly as the server stores it: a string holding the function body, or a JSON string
   * for api and plugin steps. Import may parse it, but never re-stringifies it differently.
   */
  code?: string
  /**
   * Named constants of code and API steps. On the server these live under the function row's
   * metadata.drafted.dynamicVariables (the row has no top-level dynamicVariables field).
   */
  dynamicVariables?: Record<string, unknown>
  subfunctions?: unknown
  /** Connection REFERENCE only (no secret); it resolves only in the workspace that owns the connection. */
  auth_id?: string
  /** For plugin steps: the catalog action id the create call needs (equals the code's selectedCreate). */
  action_id?: string
}

export interface FlowExportFile {
  viasocketFlowExport: typeof FLOW_EXPORT_VERSION
  source: FlowExportSource
  flow: {
    title: string
    description?: string
    /** The draft json_script: blocks, order and the trigger (including Get Data, loop, run-if and the schedule). */
    json_script: Record<string, unknown>
    /** Step details by slug, for blocks that have their own function row (plugin, function, api, ...). */
    functions: Record<string, ExportedFunction>
  }
  /** Human-readable reminder kept in the file itself. */
  note?: string
}

// ---------- content script -> background (chrome.runtime.sendMessage, reply via sendResponse) ----------

export type FlowTransferRequest =
  | { target: 'background'; type: 'flow:export'; scriptId: string; projectId: string; orgId?: string; host: string }
  | { target: 'background'; type: 'flow:import'; json: string; projectId: string; orgId?: string; host: string }

export type FlowTransferResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export interface FlowExportResult {
  fileName: string
  /** Pretty-printed FlowExportFile, ready to save as a file. */
  json: string
  title: string
  /** Parts the file could not carry (e.g. step code larger than a save accepts). */
  warnings: string[]
}

export interface FlowImportResult {
  scriptId: string
  title: string
  /** App path of the new flow on the same origin, e.g. /projects/:org/:proj/workflow/:id/draft */
  path: string
  /** Parts the new account must finish by hand (missing connections and similar). */
  warnings: string[]
}
