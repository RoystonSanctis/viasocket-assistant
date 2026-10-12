// viaSocket flow tools: build, edit, test and publish workflows through the same HTTP APIs the viaSocket UI uses.
// Implementation lives in ./flow/; this file only assembles the list in the fixed-name order.

import type { Tool } from './types'
import { FLOW_TOOL_NAMES } from './flow/names'
import { LIFECYCLE_TOOLS } from './flow/tools-lifecycle'
import { READ_TOOLS } from './flow/tools-read'
import { STEP_TOOLS } from './flow/tools-steps'
import { TRIGGER_TOOLS } from './flow/tools-trigger'

export { appPath, pagePathWithParams } from './flow/urls'

const byName = new Map<string, Tool<any>>([...READ_TOOLS, ...STEP_TOOLS, ...TRIGGER_TOOLS, ...LIFECYCLE_TOOLS].map((t) => [t.name, t]))

export const FLOW_TOOLS: Tool<any>[] = FLOW_TOOL_NAMES.map((name) => {
  const tool = byName.get(name)
  if (!tool) throw new Error(`Flow tool ${name} is missing`)
  return tool
})
