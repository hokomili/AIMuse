import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPackageSubject,
  captureSourceInputs,
  resolveSubjectManifestPath,
  verifyPackageSubject,
} from '../../scripts/package-subject.mjs';

const roots = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inputs = {
  gitHead: 'a'.repeat(40), gitBranch: 'codex/macos-compatibility', indexSha256: 'B'.repeat(64),
  dirtyStatusSha256: 'C'.repeat(64), workspaceInputsSha256: 'D'.repeat(64), workspaceInputFiles: 12,
};
const inspection = {
  architectures: { applicationExecutable: ['arm64'], audioHelper: ['arm64'], pluginScanner: ['arm64'], pluginBridge: ['arm64'] },
  signature: { kind: 'ad-hoc', valid: true, identifier: 'com.aimuse.app', teamIdentifier: 'not set', designatedRequirementSha256: 'E'.repeat(64) },
  bundle: { identifier: 'com.aimuse.app', name: 'AIMuse' },
  hardenedFuses: { RunAsNode: 'disabled' },
};

async function fixture(platform = 'darwin', architecture = 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'aimuse-subject-test-'));
  roots.push(root);
  const packageRoot = join(root, 'out', `AIMuse-${platform}-${architecture}`);
  const resources = platform === 'darwin' ? join(packageRoot, 'AIMuse.app', 'Contents', 'Resources') : join(packageRoot, 'resources');
  const executable = platform === 'darwin' ? join(packageRoot, 'AIMuse.app', 'Contents', 'MacOS', 'AIMuse') : join(packageRoot, 'AIMuse.exe');
  await mkdir(join(resources, 'native'), { recursive: true });
  await mkdir(join(executable, '..'), { recursive: true });
  const extension = platform === 'win32' ? '.exe' : '';
  await Promise.all([
    writeFile(executable, 'application'),
    writeFile(join(resources, 'app.asar'), 'archive'),
    writeFile(join(resources, 'native', `aimuse-audio${extension}`), 'audio'),
    writeFile(join(resources, 'native', `aimuse-plugin-scanner${extension}`), 'scanner'),
    writeFile(join(resources, 'native', `aimuse-plugin-bridge${extension}`), 'bridge'),
  ]);
  const runRoot = join(root, 'test-results', 'luna-high', 'run-1');
  await mkdir(runRoot, { recursive: true });
  return { root, runRoot, executable, resources };
}

describe('frozen package subjects', () => {
  it('publishes once below a run root and preserves existing evidence', async () => {
    const value = await fixture();
    const sibling = join(value.runRoot, 'preflight.json');
    await writeFile(sibling, 'immutable evidence');
    const manifestPath = join(value.runRoot, 'subject', 'package-subject.json');
    const created = await createPackageSubject({ workspace: value.root, formalRunRoot: value.runRoot, manifestPath, sourceInputs: inputs, inspect: async () => inspection });
    expect(created.manifest.inputs).toEqual(inputs);
    expect(created.manifest.subject.files.applicationAsar.sha256).toMatch(/^[A-F\d]{64}$/u);
    expect(created.manifest.subject.identitySha256).toMatch(/^[A-F\d]{64}$/u);
    expect(await readFile(sibling, 'utf8')).toBe('immutable evidence');
    await expect(createPackageSubject({ workspace: value.root, formalRunRoot: value.runRoot, manifestPath, sourceInputs: inputs, inspect: async () => inspection })).rejects.toThrow(/Refusing to overwrite/u);
    expect(await readFile(sibling, 'utf8')).toBe('immutable evidence');
  });

  it('fails on drift of every frozen component and on manifest-byte drift', async () => {
    const value = await fixture();
    const created = await createPackageSubject({ workspace: value.root, formalRunRoot: value.runRoot, sourceInputs: inputs, inspect: async () => inspection });
    await expect(verifyPackageSubject({ workspace: value.root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, platform: 'darwin', inspect: async () => inspection })).resolves.toMatchObject({ manifestSha256: created.manifestSha256 });
    for (const [role, declared] of Object.entries(created.manifest.subject.files)) {
      const path = join(value.root, ...declared.path.split('/'));
      const original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from(`-${role}-drift`)]));
      await expect(verifyPackageSubject({ workspace: value.root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, platform: 'darwin', inspect: async () => inspection })).rejects.toThrow(new RegExp(`${role} bytes drifted`, 'u'));
      await writeFile(path, original);
    }
    await writeFile(created.manifestPath, `${await readFile(created.manifestPath, 'utf8')} `);
    await expect(verifyPackageSubject({ workspace: value.root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, platform: 'darwin', inspect: async () => inspection })).rejects.toThrow(/manifest byte digest drifted/u);
  });

  it('keeps the Windows package path and helper suffix contract', async () => {
    const value = await fixture('win32', 'x64');
    const windowsInspection = { ...inspection, architectures: { applicationExecutable: ['x64'], audioHelper: ['x64'], pluginScanner: ['x64'], pluginBridge: ['x64'] }, signature: { kind: 'not-inspected', valid: null } };
    const created = await createPackageSubject({ workspace: value.root, formalRunRoot: value.runRoot, sourceInputs: inputs, platform: 'win32', architecture: 'x64', inspect: async () => windowsInspection });
    expect(created.manifest.subject.files.applicationExecutable.path.endsWith('AIMuse.exe')).toBe(true);
    expect(created.manifest.subject.files.audioHelper.path.endsWith('aimuse-audio.exe')).toBe(true);
    await expect(verifyPackageSubject({ workspace: value.root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, platform: 'win32', inspect: async () => windowsInspection })).resolves.toBeTruthy();
  });

  it('rejects broad and unrelated manifest destinations', async () => {
    const value = await fixture();
    expect(() => resolveSubjectManifestPath({ workspace: value.root, formalRunRoot: value.root })).toThrow(/run-scoped child/u);
    expect(() => resolveSubjectManifestPath({ workspace: value.root, formalRunRoot: value.runRoot, manifestPath: join(value.root, 'test-results', 'package-subject.json') })).toThrow(/must be below/u);
  });

  it('keeps ignored package/evidence output out of source-input identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-input-identity-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'out/\ntest-results/\n');
    await writeFile(join(root, 'input.txt'), 'source');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=AIMuse Test', '-c', 'user.email=test@aimuse.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    const before = await captureSourceInputs(root);
    await mkdir(join(root, 'out', 'formal-subjects', 'run'), { recursive: true });
    await writeFile(join(root, 'out', 'formal-subjects', 'run', 'package-subject.json'), 'ignored evidence');
    await mkdir(join(root, 'test-results', 'luna-high', 'run'), { recursive: true });
    await writeFile(join(root, 'test-results', 'luna-high', 'run', 'preflight.json'), 'ignored evidence');
    expect(await captureSourceInputs(root)).toEqual(before);
  });
});
