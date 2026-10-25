/** Codex CLI: configuration is separate from the untrusted user message. */
export const DEFAULT_LLM_MODEL = 'gpt-6-astra';
export type Effort = 'low' | 'medium' | 'high';

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface CliArgsInput {
  authMethod?: 'chatgpt' | 'api';
  apiBaseUrl?: string;
  system: string;
  schemaFile: string;
  model: string;
  effort?: Effort;
  imageFiles?: string[];
  disabledSkillPaths?: string[];
}

// Built against the 0.147.0 schema/source; strict-config and live calls verified on 0.162.1.
// apply_patch remains a built-in tool:
// read-only/never denies edits; the event tripwire rejects any tool activity. This
// is a restricted CLI session, not a claim that the CLI offers a zero-tool mode.
export const ISOLATION_CONFIG = [
  'approval_policy="never"',
  'project_doc_max_bytes=0',
  'project_doc_fallback_filenames=[]',
  'project_root_markers=[]',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'web_search="disabled"',
  'mcp_servers={}',
  'notify=[]',
  'history.persistence="none"',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'include_environment_context=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  ...[
    'shell_tool', 'shell_snapshot', 'unified_exec', 'view_image',
    'apps', 'plugins', 'remote_plugin', 'hooks', 'memories',
    'skill_search', 'skill_mcp_dependency_install', 'multi_agent', 'multi_agent_v2',
    'image_generation', 'browser_use', 'browser_use_external', 'computer_use',
    'in_app_browser', 'workspace_dependencies', 'goals', 'code_mode',
    'code_mode_host', 'tool_suggest', 'recommended_plugins', 'request_permissions_tool',
  ].map((feature) => `features.${feature}=false`),
] as const;

export function buildCliArgs(input: CliArgsInput): string[] {
  const args = [
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json',
    '--model', input.model, '--output-schema', input.schemaFile,
  ];
  for (const setting of ISOLATION_CONFIG) args.push('-c', setting);
  args.push('-c', `forced_login_method=${JSON.stringify(input.authMethod ?? 'chatgpt')}`);
  if (input.authMethod === 'api' && input.apiBaseUrl) {
    args.push('-c', 'model_provider="studio_api"', '-c', `model_providers.studio_api={name="Personal API",base_url=${JSON.stringify(input.apiBaseUrl)},wire_api="responses",requires_openai_auth=true}`);
  } else args.push('-c','model_provider="openai"');
  // JSON string escaping is also valid for these TOML basic strings. No shell is involved.
  args.push('-c', `developer_instructions=${JSON.stringify(input.system)}`);
  args.push('-c', `model_reasoning_effort=${JSON.stringify(input.effort ?? 'medium')}`);
  args.push('-c', `skills.config=[${(input.disabledSkillPaths ?? []).map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(',')}]`);
  for (const file of input.imageFiles ?? []) args.push('--image', file);
  args.push('-');
  return args;
}
