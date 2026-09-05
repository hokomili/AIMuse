import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCleanDependencyInventory, declareReleaseInputs } from '../../scripts/release-inputs.mjs';

const roots = [];
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function writePrivate(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function identity(role, path) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath);
  return { role, requestedPath: resolve(path), canonicalPath, bytes: info.size, sha256: sha256(await readFile(canonicalPath)) };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('caller-declared release inputs', () => {
  it('binds the stable contract, manifest source, direct tooling, dependency inventory, and run paths before automation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aimuse-release-inputs-'));
    const executionTemp = await realpath(await mkdtemp(join(tmpdir(), 'aimuse-release-execution-temp-')));
    roots.push(workspace, executionTemp);
    const runRoot = join(workspace, 'test-results', 'luna-high', 'declared-run');
    const playwrightRoot = join(workspace, 'test-results', 'playwright', 'declared-run');
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(runRoot, 0o700);
    const contractBytes = await readFile(resolve('scripts/formal-release-contract.json'));
    const contract = JSON.parse(contractBytes.toString('utf8'));
    await writePrivate(join(workspace, 'scripts', 'formal-release-contract.json'), contractBytes);
    const dummy = join(workspace, 'tool.bin');
    await writePrivate(dummy, 'tool');
    for (const path of contract.declaredTooling.controlPaths.filter((path) => path !== 'scripts/formal-release-contract.json')) await writePrivate(join(workspace, path), path);
    for (const path of Object.values(contract.declaredTooling.javascriptTools)) await writePrivate(join(workspace, path), path);
    const tool = await identity('tool', dummy);
    const tools = {
      node: { ...tool, role: 'node' }, npm: { ...tool, role: 'npm' }, git: { ...tool, role: 'git' },
      cmake: { ...tool, role: 'cmake' }, ctest: { ...tool, role: 'ctest' }, cCompiler: { ...tool, role: 'cCompiler' },
      cppCompiler: { ...tool, role: 'cppCompiler' }, scriptShell: { ...tool, role: 'scriptShell' }, rendererBrowser: { ...tool, role: 'rendererBrowser' },
      ...(process.platform === 'darwin' ? {
        codesign: { ...tool, role: 'codesign' }, lipo: { ...tool, role: 'lipo' }, plutil: { ...tool, role: 'plutil' }, xcrun: { ...tool, role: 'xcrun' },
        make: { ...tool, role: 'make' },
        linker: { ...tool, role: 'linker' }, archiver: { ...tool, role: 'archiver' }, ranlib: { ...tool, role: 'ranlib' },
      } : {}),
    };
    const sourceInputs = { gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), workspaceInputFiles: 1, workspaceInputsSha256: 'C'.repeat(64) };
    const protectedIdentity = { version: 1, canonicalPath: runRoot, device: '1', inode: '2' };
    const result = await declareReleaseInputs({
      workspace,
      environment: { AIMUSE_NPM_CLI: dummy, PATH: '/declared-path', HOME: workspace },
      level: 2,
      formalRunRoot: runRoot,
      forgeOutDirectory: join(runRoot, 'package-output'),
      playwrightOutputDirectory: playwrightRoot,
      subjectManifestPath: join(runRoot, 'package-subject.json'),
      implementationTaskId: 'implementation-task',
      executionTempDirectory: executionTemp,
      captureSource: async () => sourceInputs,
      captureToolchain: async () => tools,
      captureDependencyInventory: async () => Buffer.from('{"dependencies":{}}\n'),
      captureToolContent: async () => Object.fromEntries([
        ...Object.keys(contract.declaredTooling.contentTrees),
        ...(process.platform === 'darwin' ? Object.keys(contract.declaredTooling.darwinContentTrees) : []),
      ].map((role, index) => [role, {
        root: `${workspace}/content-${role}`,
        rootMode: 0o755,
        files: 1,
        directories: 0,
        symlinks: 0,
        entriesSha256: String(index + 1).repeat(64).slice(0, 64),
        inventory: { path: `content-tree-${role}.json`, bytes: 1, sha256: 'F'.repeat(64) },
      }])),
      captureNativeDependency: async ({ destination }) => {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        return {
          revision: contract.declaredTooling.nativeDependencies.miniaudio.revision,
          sourceDirectory: 'declared-inputs/miniaudio',
          files: 1,
          entriesSha256: 'D'.repeat(64),
          inventory: { path: 'native-dependency-miniaudio.json', bytes: 1, sha256: 'E'.repeat(64) },
        };
      },
      inspectRunRoot: async () => ({ identity: protectedIdentity, owner: 'launching-user', allowedPrincipals: ['launching-user'] }),
      resolvePlaywrightPaths: () => ({ outputDir: playwrightRoot, htmlReportDir: `${playwrightRoot}-html-report` }),
    });
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      kind: 'aimuse-declared-release-inputs',
      acceptanceVerdict: null,
      level: 2,
      implementationTaskId: 'implementation-task',
      sourceInputs,
      contract: { sha256: sha256(contractBytes) },
      protectedRunRoot: { identity: protectedIdentity },
      protectedExecutionTemp: { identity: { canonicalPath: executionTemp } },
      toolchain: { dependencyInventory: { path: 'dependency-inventory.json' }, contentInventories: expect.any(Object) },
      paths: { workspaceViteOutputDirectory: join(workspace, '.vite') },
    });
    expect(result.manifest.executionEnvironment.PATH).not.toContain('/declared-path');
    expect(result.manifest.executionEnvironment.PATH.split(delimiter)[0]).toBe(join(workspace, 'scripts', 'npm-shims'));
    expect(result.manifest.executionEnvironment.npm_config_script_shell).toBe(tool.requestedPath);
    expect(result.manifest.executionEnvironment.HOME).toBe(join(runRoot, 'execution-home'));
    expect(result.manifest.executionEnvironment.TMPDIR).toBe(executionTemp);
    expect(result.manifest.paths.nativeDistributionDirectory).toBe(join(runRoot, 'native'));
    expect(result.manifest.controls).toHaveProperty('scripts/release-command-witness.mjs');
    expect(result.manifest.controls).toHaveProperty('scripts/release-inputs.mjs');
    expect(result.manifest.toolchain.javascriptTools).toHaveProperty('playwright');
    expect(result.manifest.toolchain.contentInventories).toHaveProperty('installedDependencies');
  });

  it('rejects ambient Node mutation and signing inputs before declaration', async () => {
    await expect(declareReleaseInputs({
      level: 2,
      environment: { NODE_OPTIONS: '--inspect' },
      implementationTaskId: 'implementation-task',
    })).rejects.toThrow(/must be absent/u);
  });

  it('rejects extraneous or invalid installed dependencies before publication', async () => {
    expect(() => assertCleanDependencyInventory(Buffer.from('{"problems":["extraneous: surprise@1.0.0"]}\n'))).toThrow(/dependency tree is not clean/u);
    expect(() => assertCleanDependencyInventory(Buffer.from('{"dependencies":{"surprise":{"invalid":true}}}\n'))).toThrow(/dependency tree is not clean/u);
  });
});
