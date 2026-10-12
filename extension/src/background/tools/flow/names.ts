// Fixed tool names. The config repo's tools.json and prompts refer to these exact strings.

export const FLOW_TOOL_NAMES = [
  'vs_list_projects', 'vs_list_flows', 'vs_create_flow', 'vs_get_flow', 'vs_get_step', 'vs_search_apps',
  'vs_list_app_actions', 'vs_get_action', 'vs_list_connections', 'vs_connect_app', 'vs_add_step', 'vs_update_step',
  'vs_delete_step', 'vs_move_step', 'vs_set_trigger', 'vs_test_step', 'vs_test_flow', 'vs_get_recent_run',
  'vs_publish_flow', 'vs_discard_changes', 'vs_rename_flow',
] as const

export const DH_TOOL_NAMES = [
  'dh_search_plugins', 'dh_get_plugin', 'dh_create_plugin', 'dh_brand_details', 'dh_update_plugin', 'dh_publish_plugin',
  'dh_kb', 'dh_list_auth_versions', 'dh_create_connection', 'dh_update_auth_version', 'dh_check_connection', 'dh_connect',
  'dh_list_actions', 'dh_get_action_version', 'dh_create_action', 'dh_new_action_version', 'dh_update_action_version',
  'dh_list_components', 'dh_create_component', 'dh_map_component', 'dh_dry_run', 'dh_publish_action_version',
] as const

/** Tools a suggestion card's Apply button may run (through the normal confirmation path). Never UI tools. */
export const SUGGESTABLE_TOOLS: ReadonlySet<string> = new Set<string>([...FLOW_TOOL_NAMES, ...DH_TOOL_NAMES])
