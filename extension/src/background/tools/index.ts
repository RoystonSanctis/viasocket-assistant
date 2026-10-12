// Tool registry. The agent loop only depends on buildToolset().

import type { FlagsConfig, ToolsConfig } from '../../shared/config'
import type { PageContext } from '../../shared/page'
import type { Tool } from './types'
import { UI_TOOLS } from './ui-tools'
import { FLOW_TOOLS } from './flow-tools'
import { DH_TOOLS } from './dh-tools'

export interface ToolsetOptions {
  page: PageContext
  flags: FlagsConfig
  toolsConfig: ToolsConfig
}

const TRIGGER_TOOL_NAMES = new Set(['vs_set_trigger'])

export const ALL_TOOLS: Tool<any>[] = [...UI_TOOLS, ...FLOW_TOOLS, ...DH_TOOLS]

/** Tools offered for this page, with config description overrides applied and disabled tools removed. */
export function buildToolset({ page, flags, toolsConfig }: ToolsetOptions): Tool<any>[] {
  return ALL_TOOLS.filter((t) => {
    if (t.pages && !t.pages.includes(page.kind)) return false
    if (!flags.enableDevHub && t.name.startsWith('dh_')) return false
    if (!flags.enableTriggerTools && TRIGGER_TOOL_NAMES.has(t.name)) return false
    return toolsConfig.tools[t.name]?.enabled !== false
  }).map((t) => {
    const description = toolsConfig.tools[t.name]?.description
    return description ? { ...t, description } : t
  })
}

export function findTool(name: string): Tool<any> | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}
