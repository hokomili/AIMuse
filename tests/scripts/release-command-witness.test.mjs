import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { witnessReleaseCommand } from '../../scripts/release-command-witness.mjs';

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

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aimuse-command-witness-'));
  roots.push(workspace);
  const runRoot = join(workspace, 'test-results', 'luna-high', 'witness-run');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const contractBytes = await readFile(resolve('scripts/formal-release-contract.json'));
  const contractPath = join(workspace, 'scripts', 'formal-release-contract.json');
  await writePrivate(contractPath, contractBytes);
  const fakeNpm = join(workspace, 'npm-cli.js');
  await writePrivate(fakeNpm, 'process.stdout.write("fake npm")\n');
  const witnessPath = resolve('scripts/release-command-witness.mjs');
  const inputPath = join(runRoot, 'declared-release-inputs.json');
  const inputs = {
    schemaVersion: 2,
    kind: 'aimuse-declared-release-inputs',
    acceptanceVerdict: null,
    level: 1,
    paths: { workspace, formalRunRoot: runRoot, forgeOutDirectory: join(runRoot, 'package-output'), packagedPlaywrightOutput: join(workspace, 'test-results', 'playwright', 'witness-run'), rendererPlaywrightOutput: join(runRoot, 'renderer-playwright'), packageSubjectManifest: join(runRoot, 'package-subject.json') },
    contract: { path: 'scripts/formal-release-contract.json', bytes: contractBytes.length, sha256: sha256(contractBytes) },
    controls: { 'scripts/release-command-witness.mjs': await identity('scripts/release-command-witness.mjs', witnessPath) },
    toolchain: { externalTools: { node: await identity('node', process.execPath), npm: await identity('npm', fakeNpm) } },
    sourceInputs: { entries: [] },
    executionEnvironment: { PATH: process.env.PATH },
  };
  const inputBytes = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
  await writePrivate(inputPath, inputBytes);
  return { workspace, runRoot, inputPath, inputSha256: sha256(inputBytes), inputs };
}

describe('release command witness', () => {
  it('owns raw logs and a content-only receipt attributed to its exact bytes', async () => {
    const value = await fixture();
    const observed = await witnessReleaseCommand({
      stageId: 'verify-source',
      declaredInputsPath: value.inputPath,
      expectedDeclaredInputsSha256: value.inputSha256,
      execute: async (_command, arguments_, options) => {
        expect(arguments_.slice(-2)).toEqual(['run', 'verify']);
        expect(options.env.AIMUSE_FORMAL_RUN_ROOT).toBe(value.runRoot);
        return { childPid: 321, startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), durationMs: 1, exitCode: 0, signal: null, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0) };
      },
    });
    expect(observed.receipt).toMatchObject({
      schemaVersion: 2,
      kind: 'aimuse-witnessed-command-execution',
      acceptanceVerdict: null,
      stageId: 'verify-source',
      attribution: { childPid: 321, witnessSha256: value.inputs.controls['scripts/release-command-witness.mjs'].sha256 },
      termination: { exitCode: 0, signal: null },
    });
    await expect(readFile(join(value.runRoot, observed.receipt.stdout.path), 'utf8')).resolves.toBe('ok\n');
  });

  it('rejects an undeclared stage and pre-subject package injection', async () => {
    const value = await fixture();
    await expect(witnessReleaseCommand({ stageId: 'not-a-stage', declaredInputsPath: value.inputPath, expectedDeclaredInputsSha256: value.inputSha256 })).rejects.toThrow(/not declared/u);
    await expect(witnessReleaseCommand({
      stageId: 'verify-source', declaredInputsPath: value.inputPath, expectedDeclaredInputsSha256: value.inputSha256,
      packageSubjectPath: value.inputs.paths.packageSubjectManifest, expectedPackageSubjectSha256: 'A'.repeat(64),
    })).rejects.toThrow(/may not receive/u);
  });
});
