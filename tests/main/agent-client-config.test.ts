import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAgentClientFile, genericSetupSnippet, updateCodexToml } from '@main/agent-client-config';

const temporaryDirectories: string[] = [];
const connection = { url: 'http://127.0.0.1:49152/mcp', token: 'private-test-token' };
const now = new Date('2026-08-08T01:02:03.456Z');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aimuse-agent-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('cross-agent MCP configuration', () => {
  it('replaces only the Codex AIMuse table and its subtables', () => {
    const existing = '[features]\nweb_search = true\n\n[mcp_servers.aimuse]\nurl = "old"\n\n[mcp_servers.aimuse.env]\nOLD = "secret"\n\n[mcp_servers.keep]\nurl = "https://example.test"\n';
    const updated = updateCodexToml(existing, connection);
    expect(updated).toContain('[features]\nweb_search = true');
    expect(updated).toContain('[mcp_servers.keep]\nurl = "https://example.test"');
    expect(updated).not.toContain('OLD =');
    expect(updated.match(/\[mcp_servers\.aimuse\]/g)).toHaveLength(1);
    expect(updated).toContain('http_headers = { Authorization = "Bearer private-test-token" }');
  });

  it('backs up and safely updates Codex user configuration', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.codex', 'config.toml');
    const original = '[model]\nname = "keep-me"\n';
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(configPath, original, 'utf8');
    const result = await configureAgentClientFile('codex', connection, { homeDirectory: home, environment: {}, now });
    expect(result).toMatchObject({ status: 'configured', clientId: 'codex', configPath, restartRequired: true });
    expect(await readFile(result.backupPath!, 'utf8')).toBe(original);
    expect(await readFile(configPath, 'utf8')).toContain('[model]\nname = "keep-me"');
  });

  it('preserves unrelated Claude Code user settings', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.claude.json');
    await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: { keep: { type: 'http', url: 'https://keep.test' }, aimuse: { url: 'old' } } }, null, 2), 'utf8');
    await configureAgentClientFile('claude-code', connection, { homeDirectory: home, environment: {}, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> };
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.keep).toEqual({ type: 'http', url: 'https://keep.test' });
    expect(config.mcpServers.aimuse).toEqual({ type: 'http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('updates stable OpenCode JSONC without discarding comments or sibling servers', async () => {
    const home = await temporaryHome();
    const configRoot = join(home, 'xdg');
    const configPath = join(configRoot, 'opencode', 'opencode.jsonc');
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    await writeFile(configPath, '{\n  // keep this explanation\n  "mcp": { "keep": { "type": "remote", "url": "https://keep.test", "enabled": true }, },\n}\n', 'utf8');
    await configureAgentClientFile('opencode', connection, { homeDirectory: home, environment: { XDG_CONFIG_HOME: configRoot }, now });
    const text = await readFile(configPath, 'utf8');
    const config = parse(text) as { mcp: Record<string, unknown> };
    expect(text).toContain('// keep this explanation');
    expect(config.mcp.keep).toMatchObject({ url: 'https://keep.test', enabled: true });
    expect(config.mcp.aimuse).toEqual({ type: 'remote', url: connection.url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('supports the OpenCode V2 mcp.servers wrapper without moving unrelated entries', async () => {
    const home = await temporaryHome();
    const configRoot = join(home, 'xdg');
    const configPath = join(configRoot, 'opencode', 'opencode.json');
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    await writeFile(configPath, JSON.stringify({ theme: 'keep', mcp: { servers: { keep: { type: 'remote', url: 'https://keep.test' }, aimuse: { type: 'remote', url: 'old' } } } }, null, 2), 'utf8');
    await configureAgentClientFile('opencode', connection, { homeDirectory: home, environment: { XDG_CONFIG_HOME: configRoot }, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { theme: string; mcp: { servers: Record<string, unknown> } };
    expect(config.theme).toBe('keep');
    expect(config.mcp.servers.keep).toEqual({ type: 'remote', url: 'https://keep.test' });
    expect(config.mcp.servers.aimuse).toEqual({ type: 'remote', url: connection.url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('writes the documented Antigravity remote-server schema', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.gemini', 'config', 'mcp_config.json');
    const result = await configureAgentClientFile('antigravity', connection, { homeDirectory: home, environment: {}, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(result.configPath).toBe(configPath);
    expect(config.mcpServers.aimuse).toEqual({ serverUrl: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('returns explicit generic Streamable HTTP settings without writing a file', async () => {
    const result = await configureAgentClientFile('generic', connection);
    expect(result).toMatchObject({ status: 'manual', clientId: 'generic', restartRequired: false, setupSnippet: genericSetupSnippet(connection) });
    expect(JSON.parse(result.setupSnippet!)).toEqual({ transport: 'streamable-http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('refuses to overwrite malformed client configuration', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.claude.json');
    await writeFile(configPath, '{ invalid', 'utf8');
    await expect(configureAgentClientFile('claude-code', connection, { homeDirectory: home, environment: {}, now })).rejects.toThrow(/invalid JSON/);
    await expect(readFile(configPath, 'utf8')).resolves.toBe('{ invalid');
  });

  it('refuses to replace an incompatible client configuration container', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.claude.json');
    const original = JSON.stringify({ theme: 'keep', mcpServers: 'managed-elsewhere' }, null, 2);
    await writeFile(configPath, original, 'utf8');
    await expect(configureAgentClientFile('claude-code', connection, { homeDirectory: home, environment: {}, now })).rejects.toThrow(/non-object mcpServers/);
    await expect(readFile(configPath, 'utf8')).resolves.toBe(original);
  });
});
