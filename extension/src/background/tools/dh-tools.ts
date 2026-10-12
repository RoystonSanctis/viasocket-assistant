// Developer Hub tools: build, edit, test and publish plugs (custom apps) through the same table API the
// Developer Hub UI uses. Implementation lives in ./dh/; tools/index.ts imports this list.

import type { Tool } from './types'
import { ACTION_TOOLS } from './dh/action-tools'
import { AUTH_TOOLS } from './dh/auth-tools'
import { PLUGIN_TOOLS } from './dh/plugin-tools'
import { READ_TOOLS } from './dh/read-tools'
import { RUN_TOOLS } from './dh/run-tools'

export const DH_TOOLS: Tool<any>[] = [...PLUGIN_TOOLS, ...READ_TOOLS, ...AUTH_TOOLS, ...ACTION_TOOLS, ...RUN_TOOLS]
