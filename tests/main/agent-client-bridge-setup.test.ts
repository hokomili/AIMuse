import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_CLIENTS, buildAgentClientSetup } from '../../src/common/agent-clients';
import {
  bootstrapMcpBridgeEntry,
  buildMcpBridgeLaunch,
  installMcpBridgeEntry,
  mcpBridgeElectronUserDataPath,
  resolveMcpBridgeEntry,
  type McpBridgeDirectoryIdentity,
  type McpBridgeFilesystem,
} from '../../src/main/mcp-bridge-entry';

const targetProfilePath = '/Users/example/Library/Application Support/AIMuse';
const launch = buildMcpBridgeLaunch({
  executablePath: '/Applications/AIMuse.app/Contents/MacOS/AIMuse',
  appPath: '/Applications/AIMuse.app/Contents/Resources/app.asar',
  packaged: true,
  targetProfilePath,
});

async function profileFixture(): Promise<{ root: string; target: string }> {
  const canonicalTemp = await realpath(tmpdir());
  const root = await mkdtemp(join(canonicalTemp, 'aimuse-mcp-entry-'));
  const target = join(root, 'AIMuse');
  await mkdir(target, { mode: 0o700 });
  return { root, target };
}

function fixtureLaunch(target: string) {
  return buildMcpBridgeLaunch({ executablePath: '/Applications/AIMuse.app/Contents/MacOS/AIMuse', appPath: '/app.asar', packaged: true, targetProfilePath: target });
}

describe('one-time MCP bridge client setup', () => {
  it('emits static stdio configuration for every supported client without engine authority or a Chromium profile switch', () => {
    for (const client of AGENT_CLIENTS) {
      const first = buildAgentClientSetup(client.id, launch);
      const second = buildAgentClientSetup(client.id, launch);
      expect(second).toEqual(first);
      expect(first).toMatchObject({ status: 'one-time', clientId: client.id, restartRequired: true });
      expect(first.setupSnippet).toContain('--mcp-bridge');
      expect(first.setupSnippet).toContain('--mcp-target-profile=');
      expect(first.setupSnippet).not.toContain('--user-data-dir');
      expect(first.setupSnippet).not.toMatch(/https?:|bearer|authorization|token|instanceId|profileId|"pid"/iu);
    }
  });

  it('uses native stdio shapes rather than a remote MCP endpoint', () => {
    expect(buildAgentClientSetup('codex', launch).setupSnippet).toContain('[mcp_servers.aimuse]');
    expect(JSON.parse(buildAgentClientSetup('claude-code', launch).setupSnippet)).toEqual({ mcpServers: { aimuse: launch } });
    expect(JSON.parse(buildAgentClientSetup('antigravity', launch).setupSnippet)).toEqual({ mcpServers: { aimuse: launch } });
    expect(JSON.parse(buildAgentClientSetup('generic', launch).setupSnippet)).toEqual({ transport: 'stdio', ...launch });
    expect(JSON.parse(buildAgentClientSetup('opencode', launch).setupSnippet)).toEqual({ mcp: { aimuse: { type: 'local', command: [launch.command, ...launch.args], enabled: true } } });
  });

  it('creates and revalidates the final deterministic bridge directory without recursively inventing its parent', async () => {
    const fixture = await profileFixture();
    try {
      const entry = resolveMcpBridgeEntry(fixtureLaunch(fixture.target).args);
      expect(entry).toMatchObject({
        targetProfilePath: fixture.target,
        electronUserDataPath: mcpBridgeElectronUserDataPath(fixture.target),
      });
      expect(entry?.electronUserDataIdentity.canonicalPath).not.toBe(entry?.targetIdentity.canonicalPath);
      expect((await stat(entry!.electronUserDataPath)).mode & 0o077).toBe(0);
      expect(() => resolveMcpBridgeEntry([
        '--mcp-bridge',
        `--mcp-target-profile=${fixture.target}`,
        `--user-data-dir=${fixture.target}`,
      ])).toThrow(/forbids --user-data-dir/u);
      const missingTarget = join(fixture.root, 'missing-parent', 'AIMuse');
      expect(() => resolveMcpBridgeEntry(fixtureLaunch(missingTarget).args)).toThrow();
      await expect(access(join(fixture.root, 'missing-parent'))).rejects.toThrow();
    } finally { await rm(fixture.root, { force: true, recursive: true }); }
  });

  it('rejects the reviewer-reproduced POSIX symlink from the deterministic bridge directory to the target', async () => {
    const fixture = await profileFixture();
    try {
      const bridge = mcpBridgeElectronUserDataPath(fixture.target);
      await symlink(fixture.target, bridge, 'dir');
      expect(await realpath(bridge)).toBe(await realpath(fixture.target));
      expect(() => resolveMcpBridgeEntry(fixtureLaunch(fixture.target).args)).toThrow(/symbolic link|alias/u);
    } finally { await rm(fixture.root, { force: true, recursive: true }); }
  });

  it('prohibits activation before validation and exits malformed packaged bridge entries immediately', async () => {
    const fixture = await profileFixture();
    try {
      const bridge = mcpBridgeElectronUserDataPath(fixture.target);
      await symlink(fixture.target, bridge, 'dir');
      const events: string[] = [];
      const app = {
        disableHardwareAcceleration: () => events.push('hardware-disabled'),
        exit: (code: number) => events.push(`exit-${code}`),
        getPath: () => '',
        setActivationPolicy: (policy: string) => events.push(`activation-${policy}`),
        setName: () => events.push('name-isolated'),
        setPath: () => events.push('path-installed'),
      } as unknown as Parameters<typeof bootstrapMcpBridgeEntry>[1];
      expect(bootstrapMcpBridgeEntry(fixtureLaunch(fixture.target).args, app, { platform: 'darwin' })).toEqual({ requested: true, failed: true });
      expect(events).toEqual(['hardware-disabled', 'activation-prohibited', 'exit-1']);
    } finally { await rm(fixture.root, { force: true, recursive: true }); }
  });

  it.each([
    {
      name: 'case-equivalent canonical paths',
      target: { canonicalPath: '/Volume/AIMuse', filesystemId: 'volume:41', linkLike: false },
      bridge: { canonicalPath: '/volume/aimuse', filesystemId: 'volume:42', linkLike: false },
    },
    {
      name: 'junction-equivalent filesystem IDs',
      target: { canonicalPath: '/Volume/AIMuse', filesystemId: 'volume:41', linkLike: false },
      bridge: { canonicalPath: '/Volume/Bridge', filesystemId: 'volume:41', linkLike: false },
    },
    {
      name: 'reparse-backed bridge paths',
      target: { canonicalPath: '/Volume/AIMuse', filesystemId: 'volume:41', linkLike: false },
      bridge: { canonicalPath: '/Volume/Bridge', filesystemId: 'volume:42', linkLike: true },
    },
  ] satisfies Array<{ name: string; target: McpBridgeDirectoryIdentity; bridge: McpBridgeDirectoryIdentity }>)('rejects injected Windows $name', ({ target, bridge }) => {
    const filesystem: McpBridgeFilesystem = {
      createDirectory: vi.fn(),
      assertLinkFreeDirectory: vi.fn(),
      inspectDirectory: vi.fn((path) => path === targetProfilePath ? target : bridge),
    };
    expect(() => resolveMcpBridgeEntry(launch.args, { filesystem, platform: 'win32' })).toThrow(/link-free directory|cannot alias/u);
  });

  it('executes the real bootstrap before app.setPath and fails if identity changes during installation', () => {
    let installedPath = '';
    let changed = false;
    const target: McpBridgeDirectoryIdentity = { canonicalPath: '/Volume/AIMuse', filesystemId: 'volume:41', linkLike: false };
    const bridge: McpBridgeDirectoryIdentity = { canonicalPath: '/Volume/Bridge', filesystemId: 'volume:42', linkLike: false };
    const filesystem: McpBridgeFilesystem = {
      createDirectory: vi.fn(),
      assertLinkFreeDirectory: vi.fn(),
      inspectDirectory: vi.fn((path) => path === targetProfilePath
        ? target
        : changed ? { ...bridge, filesystemId: 'volume:99' } : bridge),
    };
    const app = {
      disableHardwareAcceleration: vi.fn(),
      getPath: vi.fn(() => installedPath),
      setActivationPolicy: vi.fn(),
      setName: vi.fn(),
      setPath: vi.fn((_name: string, path: string) => { installedPath = path; changed = true; }),
    } as unknown as Parameters<typeof installMcpBridgeEntry>[1];
    expect(() => installMcpBridgeEntry(launch.args, app, { filesystem, platform: 'win32' })).toThrow(/filesystem identity changed/u);
    expect(app.setPath).toHaveBeenCalledOnce();
  });

  it('binds main to the behavior-tested bootstrap, prohibited activation, and target-only discovery', async () => {
    const fixture = await profileFixture();
    try {
      const events: string[] = [];
      let installedPath = '';
      const app = {
        disableHardwareAcceleration: () => events.push('hardware-disabled'),
        getPath: () => installedPath,
        setActivationPolicy: (policy: string) => events.push(`activation-${policy}`),
        setName: () => events.push('name-isolated'),
        setPath: (_name: string, path: string) => { installedPath = path; events.push('path-installed'); },
      } as unknown as Parameters<typeof installMcpBridgeEntry>[1];
      const entry = installMcpBridgeEntry(fixtureLaunch(fixture.target).args, app, { platform: 'darwin' });
      expect(entry?.electronUserDataPath).toBe(installedPath);
      expect(events).toEqual(['hardware-disabled', 'activation-prohibited', 'name-isolated', 'path-installed']);

      const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
      expect(source).toContain('bootstrapMcpBridgeEntry(applicationArguments, app)');
      expect(source).toContain('if (bridgeBootstrap.failed)');
      expect(source).toContain('if (!bridgeMode)');
      expect(source).not.toContain('if (!bridgeEntry)');
      expect(source).not.toContain("app.setPath('userData', bridgeEntry.electronUserDataPath)");
      expect(source).toContain('buildMcpBridgeLaunch({ executablePath: process.execPath');
      expect(source).toContain('runMcpStdioBridge({ userDataPath: bridgeEntry.targetProfilePath');
      expect(source).not.toContain("runMcpStdioBridge({ userDataPath: app.getPath('userData')");
    } finally { await rm(fixture.root, { force: true, recursive: true }); }
  });
});
