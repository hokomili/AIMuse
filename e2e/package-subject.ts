import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

interface SubjectFile { path: string; bytes: number; sha256: string }
interface PackageSubjectManifest {
  schemaVersion: 2;
  acceptanceVerdict: null;
  subject: {
    platform: string;
    architecture: string;
    files: { applicationExecutable: SubjectFile };
  };
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
function defaultExecutable(): string {
  return process.platform === 'darwin'
    ? resolve('out', `AIMuse-darwin-${process.arch}`, 'AIMuse.app', 'Contents', 'MacOS', 'AIMuse')
    : process.platform === 'win32'
      ? resolve('out', `AIMuse-win32-${process.arch}`, 'AIMuse.exe')
      : resolve('out', `AIMuse-linux-${process.arch}`, 'AIMuse');
}

export function packagedE2eSubject(environment: NodeJS.ProcessEnv = process.env, workspace = resolve('.')): { executable: string; exact: boolean } {
  const manifestPath = environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  if (!manifestPath) return { executable: defaultExecutable(), exact: false };
  const expectedManifestSha256 = environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  if (!expectedManifestSha256 || !/^[A-F\d]{64}$/iu.test(expectedManifestSha256)) throw new Error('Manifest-bound packaged E2E requires AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256.');
  const manifestBytes = readFileSync(resolve(manifestPath));
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256.toUpperCase()) throw new Error(`Packaged E2E subject manifest drifted: expected ${expectedManifestSha256}, observed ${manifestSha256}.`);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as PackageSubjectManifest;
  if (manifest.schemaVersion !== 2 || manifest.subject?.platform !== process.platform || manifest.acceptanceVerdict !== null) throw new Error('Packaged E2E subject manifest does not match the content-only schema or this platform.');
  const declared = manifest.subject.files?.applicationExecutable;
  if (!declared || isAbsolute(declared.path) || declared.path.split(/[\\/]/u).includes('..')) throw new Error('Packaged E2E subject executable path is invalid.');
  const workspaceRoot = resolve(workspace);
  const executable = resolve(workspaceRoot, declared.path);
  const workspaceRelative = relative(workspaceRoot, executable);
  if (!workspaceRelative || workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) throw new Error('Packaged E2E subject executable escaped the workspace.');
  if (!existsSync(executable)) throw new Error(`Manifest-bound packaged E2E executable is missing: ${executable}`);
  const executableBytes = readFileSync(executable);
  if (executableBytes.length !== declared.bytes || sha256(executableBytes) !== declared.sha256) throw new Error('Manifest-bound packaged E2E executable bytes drifted before launch.');
  return { executable, exact: true };
}
