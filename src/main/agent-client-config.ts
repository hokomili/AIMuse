import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { agentClientDescriptor, type AgentClientId, type AgentClientSetupResult } from '../common/agent-clients';

export interface McpConnectionDetails {
  url: string;
  token: string;
}

export interface AgentClientConfigOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: Date;
}

interface ConfigWriteResult {
  configPath: string;
  backupPath?: string;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
}

export function updateCodexToml(existing: string, connection: McpConnectionDetails): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const retained: string[] = [];
  let skip = false;
  for (const line of lines) {
    const table = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (table) skip = /^mcp_servers\.(?:aimuse|"aimuse"|'aimuse')(?:\.|$)/.test(table);
    if (!skip) retained.push(line);
  }
  while (retained.length && !retained.at(-1)?.trim()) retained.pop();
  const table = [
    '[mcp_servers.aimuse]',
    `url = "${escapeToml(connection.url)}"`,
    `http_headers = { Authorization = "Bearer ${escapeToml(connection.token)}" }`,
  ];
  return `${retained.join(eol)}${retained.length ? `${eol}${eol}` : ''}${table.join(eol)}${eol}`;
}

function assertJsonObject(text: string, configPath: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length) {
    throw new Error(`${configPath} contains invalid JSON/JSONC (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}).`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${configPath} must contain a JSON object.`);
  return value as Record<string, unknown>;
}

function setJsonValue(text: string, path: (string | number)[], value: unknown): string {
  const source = text.trim() ? text : '{}\n';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return applyEdits(source, modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  }));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function updateAgentJson(clientId: Exclude<AgentClientId, 'codex' | 'generic'>, existing: string, configPath: string, connection: McpConnectionDetails): string {
  const document = assertJsonObject(existing, configPath);
  const authorization = `Bearer ${connection.token}`;
  if (clientId === 'claude-code') {
    if (Object.hasOwn(document, 'mcpServers') && !objectValue(document.mcpServers)) throw new Error(`${configPath} has a non-object mcpServers value; AIMuse will not replace it.`);
    return setJsonValue(existing, ['mcpServers', 'aimuse'], {
      type: 'http',
      url: connection.url,
      headers: { Authorization: authorization },
    });
  }
  if (clientId === 'opencode') {
    let updated = existing;
    if (!updated.trim()) updated = setJsonValue(updated, ['$schema'], 'https://opencode.ai/config.json');
    const mcp = objectValue(document.mcp);
    if (Object.hasOwn(document, 'mcp') && !mcp) throw new Error(`${configPath} has a non-object mcp value; AIMuse will not replace it.`);
    const servers = objectValue(mcp?.servers);
    if (mcp && Object.hasOwn(mcp, 'aimuse') && servers && Object.hasOwn(servers, 'aimuse')) throw new Error(`${configPath} contains AIMuse entries in both supported OpenCode locations; remove one and retry.`);
    const useV2Wrapper = Boolean(servers && (Object.hasOwn(servers, 'aimuse') || !Object.hasOwn(mcp ?? {}, 'aimuse')));
    return setJsonValue(updated, useV2Wrapper ? ['mcp', 'servers', 'aimuse'] : ['mcp', 'aimuse'], {
      type: 'remote',
      url: connection.url,
      enabled: true,
      oauth: false,
      headers: { Authorization: authorization },
    });
  }
  if (Object.hasOwn(document, 'mcpServers') && !objectValue(document.mcpServers)) throw new Error(`${configPath} has a non-object mcpServers value; AIMuse will not replace it.`);
  return setJsonValue(existing, ['mcpServers', 'aimuse'], {
    serverUrl: connection.url,
    headers: { Authorization: authorization },
  });
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then((entry) => entry.isFile(), () => false);
}

async function resolveConfigPath(clientId: Exclude<AgentClientId, 'generic'>, options: AgentClientConfigOptions): Promise<string> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  if (clientId === 'codex') return join(environment.CODEX_HOME || join(home, '.codex'), 'config.toml');
  if (clientId === 'claude-code') return environment.AIMUSE_CLAUDE_CONFIG_PATH || join(home, '.claude.json');
  if (clientId === 'antigravity') return environment.AIMUSE_ANTIGRAVITY_CONFIG_PATH || join(home, '.gemini', 'config', 'mcp_config.json');
  if (environment.AIMUSE_OPENCODE_CONFIG_PATH) return environment.AIMUSE_OPENCODE_CONFIG_PATH;
  const root = environment.XDG_CONFIG_HOME || join(home, '.config');
  const jsonPath = join(root, 'opencode', 'opencode.json');
  const jsoncPath = join(root, 'opencode', 'opencode.jsonc');
  return await exists(jsonPath) || !await exists(jsoncPath) ? jsonPath : jsoncPath;
}

async function writeConfig(configPath: string, contents: string, expectedExisting: string, now: Date): Promise<ConfigWriteResult> {
  await mkdir(dirname(configPath), { recursive: true });
  let existing = '';
  let existed = false;
  try {
    existing = await readFile(configPath, 'utf8');
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== expectedExisting) throw new Error(`${configPath} changed while AIMuse was preparing the update; retry setup.`);
  let backupPath: string | undefined;
  if (existed) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backupPath = `${configPath}.aimuse-backup-${stamp}`;
    await copyFile(configPath, backupPath);
    await chmod(backupPath, 0o600);
  }
  const temporaryPath = `${configPath}.aimuse-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  return { configPath, backupPath };
}

export function genericSetupSnippet(connection: McpConnectionDetails): string {
  return JSON.stringify({
    transport: 'streamable-http',
    url: connection.url,
    headers: { Authorization: `Bearer ${connection.token}` },
  }, null, 2);
}

export async function configureAgentClientFile(clientId: AgentClientId, connection: McpConnectionDetails, options: AgentClientConfigOptions = {}): Promise<AgentClientSetupResult> {
  const descriptor = agentClientDescriptor(clientId);
  if (clientId === 'generic') {
    return {
      status: 'manual', clientId, clientName: descriptor.name,
      message: 'Copy these authenticated Streamable HTTP settings into the client. Keep the bearer token private.',
      restartRequired: false, restartInstruction: descriptor.restartInstruction,
      documentationUrl: descriptor.documentationUrl, setupSnippet: genericSetupSnippet(connection),
    };
  }
  const configPath = await resolveConfigPath(clientId, options);
  let existing = '';
  try { existing = await readFile(configPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const contents = clientId === 'codex'
    ? updateCodexToml(existing, connection)
    : updateAgentJson(clientId, existing, configPath, connection);
  const written = await writeConfig(configPath, contents, existing, options.now ?? new Date());
  return {
    status: 'configured', clientId, clientName: descriptor.name,
    message: `AIMuse replaced only the aimuse MCP entry in ${configPath}${written.backupPath ? ' and saved a timestamped backup' : ''}.`,
    restartRequired: true, restartInstruction: descriptor.restartInstruction,
    documentationUrl: descriptor.documentationUrl, ...written,
  };
}
