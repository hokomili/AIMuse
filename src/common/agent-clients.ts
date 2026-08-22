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
    configurationDescription: 'your client’s stdio MCP settings',
    restartInstruction: 'Reconnect or restart the client once after adding the AIMuse bridge.',
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
  status: 'one-time';
  clientId: AgentClientId;
  clientName: string;
  message: string;
  restartRequired: boolean;
  restartInstruction: string;
  documentationUrl: string;
  setupSnippet: string;
}

export interface AgentClientBridgeLaunch {
  command: string;
  args: string[];
}

function jsonSetup(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Builds copy-only, durable client configuration. It must never receive or emit engine authority. */
export function buildAgentClientSetup(clientId: AgentClientId, launch: AgentClientBridgeLaunch): AgentClientSetupResult {
  const descriptor = agentClientDescriptor(clientId);
  const command = launch.command;
  const args = [...launch.args];
  let setupSnippet: string;
  if (clientId === 'codex') {
    setupSnippet = [
      '[mcp_servers.aimuse]',
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      'startup_timeout_sec = 300',
      'tool_timeout_sec = 600',
    ].join('\n');
  } else if (clientId === 'opencode') {
    setupSnippet = jsonSetup({
      mcp: {
        aimuse: {
          type: 'local',
          command: [command, ...args],
          enabled: true,
        },
      },
    });
  } else if (clientId === 'generic') {
    setupSnippet = jsonSetup({ transport: 'stdio', command, args });
  } else {
    setupSnippet = jsonSetup({ mcpServers: { aimuse: { command, args } } });
  }
  return {
    status: 'one-time',
    clientId,
    clientName: descriptor.name,
    message: `Add this once to ${descriptor.configurationDescription}. AIMuse derives and verifies link-free isolated browser state, waits for the app, and reconnects automatically after engine restarts; the configuration contains no browser-state switch, bearer, or per-launch value.`,
    restartRequired: true,
    restartInstruction: descriptor.restartInstruction,
    documentationUrl: descriptor.documentationUrl,
    setupSnippet,
  };
}
