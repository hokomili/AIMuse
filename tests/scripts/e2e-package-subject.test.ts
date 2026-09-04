import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packagedE2eSubject } from '../../e2e/package-subject';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }

async function fixture(): Promise<{ root: string; executable: string; manifestPath: string; manifestSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aimuse-e2e-subject-'));
  roots.push(root);
  const executable = join(root, 'out', `AIMuse-${process.platform}-${process.arch}`, process.platform === 'darwin' ? 'AIMuse.app/Contents/MacOS/AIMuse' : 'AIMuse.exe');
  await mkdir(join(executable, '..'), { recursive: true });
  const executableBytes = Buffer.from('exact application bytes');
  await writeFile(executable, executableBytes);
  const relativeExecutable = relative(root, executable).split(sep).join('/');
  const manifest = { schemaVersion: 2, acceptanceVerdict: null, subject: { platform: process.platform, architecture: process.arch, files: { applicationExecutable: { path: relativeExecutable, bytes: executableBytes.length, sha256: sha256(executableBytes) } } } };
  const manifestPath = join(root, 'subject.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, manifestBytes);
  return { root, executable, manifestPath, manifestSha256: sha256(manifestBytes) };
}

describe('manifest-bound packaged E2E selection', () => {
  it('resolves and hashes the exact declared executable', async () => {
    const value = await fixture();
    expect(packagedE2eSubject({ AIMUSE_PACKAGE_SUBJECT_MANIFEST: value.manifestPath, AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: value.manifestSha256 }, value.root)).toEqual({ executable: value.executable, exact: true });
  });

  it('fails closed on manifest or executable drift while retaining developer fallback', async () => {
    const value = await fixture();
    await writeFile(value.executable, 'drift');
    expect(() => packagedE2eSubject({ AIMUSE_PACKAGE_SUBJECT_MANIFEST: value.manifestPath, AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: value.manifestSha256 }, value.root)).toThrow(/executable bytes drifted/u);
    await writeFile(value.manifestPath, `${await readFile(value.manifestPath, 'utf8')} `);
    expect(() => packagedE2eSubject({ AIMUSE_PACKAGE_SUBJECT_MANIFEST: value.manifestPath, AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: value.manifestSha256 }, value.root)).toThrow(/manifest drifted/u);
    expect(packagedE2eSubject({}, value.root).exact).toBe(false);
  });
});
