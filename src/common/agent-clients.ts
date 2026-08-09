export type AgentClientId = 'codex' | 'claude-code' | 'opencode' | 'antigravity' | 'generic';

export interface AgentClientDescriptor {
  id: AgentClientId;
  name: string;
  configuration: 'toml' | 'json' | 'jsonc' | 'manual';
  configurationDescription: string;
  restartInstruction: string;
  documentationUrl: string;
}

export const AGENT_CLIENTS: readonly AgentClientDescriptor[] = [
  {
    id: 'codex',
    name: 'Codex',
    configuration: 'toml',
    configurationDescription: 'the user Codex config.toml file',
    restartInstruction: 'Fully quit and restart Codex, then start a new task.',
    documentationUrl: 'https://developers.openai.com/codex/mcp/',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    configuration: 'json',
    configurationDescription: 'the user-scoped ~/.claude.json file',
    restartInstruction: 'Start a new Claude Code session, then run /mcp to verify AIMuse.',
    documentationUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    configuration: 'jsonc',
    configurationDescription: 'the global OpenCode JSON or JSONC configuration',
    restartInstruction: 'Restart OpenCode, then run opencode mcp list to verify AIMuse.',
    documentationUrl: 'https://opencode.ai/docs/mcp-servers/',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    configuration: 'json',
    configurationDescription: 'the global ~/.gemini/config/mcp_config.json file',
    restartInstruction: 'Restart Antigravity and verify AIMuse in Agent Settings → Customizations.',
    documentationUrl: 'https://antigravity.google/docs/mcp',
  },
  {
    id: 'generic',
    name: 'Other MCP client',
    configuration: 'manual',
    configurationDescription: 'your client’s Streamable HTTP MCP settings',
    restartInstruction: 'Reconnect or restart the client after adding the AIMuse endpoint.',
    documentationUrl: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports',
  },
] as const;

export function agentClientDescriptor(id: AgentClientId): AgentClientDescriptor {
  const descriptor = AGENT_CLIENTS.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`Unsupported agent client: ${id as string}`);
  return descriptor;
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return typeof value === 'string' && AGENT_CLIENTS.some((client) => client.id === value);
}

export interface AgentClientSetupResult {
  status: 'configured' | 'cancelled' | 'manual';
  clientId: AgentClientId;
  clientName: string;
  message: string;
  restartRequired: boolean;
  restartInstruction: string;
  documentationUrl: string;
  configPath?: string;
  backupPath?: string;
  setupSnippet?: string;
  startsAtLogin?: boolean;
}
