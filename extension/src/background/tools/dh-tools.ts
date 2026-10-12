// Developer Hub tools: search, build, connect, test and publish plugs (custom apps) through the same REST API the
// Developer Hub UI uses, following the user's Developer Hub skill (SKILL-PLUG-CREATION.md) for how each step is done.
// Implementation lives in ./dh/; tools/index.ts imports this list.

import type { Tool } from './types'
import { ACTION_TOOLS } from './dh/action-tools'
import { AUTH_TOOLS } from './dh/auth-tools'
import { COMPONENT_TOOLS } from './dh/component-tools'
import { CONNECT_TOOLS } from './dh/connect-tools'
import { KB_TOOLS } from './dh/kb-tools'
import { PLUGIN_TOOLS } from './dh/plugin-tools'
import { READ_TOOLS } from './dh/read-tools'
import { RUN_TOOLS } from './dh/run-tools'

export const DH_TOOLS: Tool<any>[] = [
  ...PLUGIN_TOOLS,
  ...KB_TOOLS,
  ...AUTH_TOOLS,
  ...CONNECT_TOOLS,
  ...READ_TOOLS,
  ...ACTION_TOOLS,
  ...COMPONENT_TOOLS,
  ...RUN_TOOLS,
]
