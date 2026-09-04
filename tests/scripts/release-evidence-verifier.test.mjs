import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseEvidence } from '../../scripts/release-evidence-verifier.mjs';

const roots = [];
const controls = [
  'scripts/initial-snapshot-manifest.json',
  'scripts/formal-package-workflow.mjs',
  'scripts/package-subject.mjs',
  'scripts/package-subject-verifier.mjs',
  'scripts/release-evidence-verifier.mjs',
  'scripts/release-protected-root-verifier.mjs',
  'scripts/verify-package.mjs',
];
const stages = [
  ['capture-source-inputs', 'internal-observation'],
  ['verify-source', 'command-observation', [process.execPath, '/tools/npm-cli.js', 'run', 'verify']],
  ['native-test', 'command-observation', [process.execPath, '/tools/npm-cli.js', 'run', 'native:test']],
  ['package-preflight', 'command-observation', [process.execPath, '/tools/npm-cli.js', 'run', 'prepackage']],
  ['package-artifact-once', 'command-observation', [process.execPath, '/tools/npm-cli.js', 'run', 'package:artifact']],
  ['confirm-source-inputs', 'internal-observation'],
  ['create-subject-manifest', 'internal-observation'],
  ['verify-subject-before-verifier', 'internal-observation'],
  ['verify-package-from-subject', 'command-observation', [process.execPath, 'scripts/verify-package.mjs']],
  ['verify-subject-after-verifier', 'internal-observation'],
  ['verify-subject-at-e2e-handoff', 'internal-observation'],
  ['packaged-e2e-from-subject', 'command-observation', [process.execPath, '/tools/npm-cli.js', 'run', 'test:e2e:only']],
  ['verify-subject-after-e2e', 'internal-observation'],
];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aimuse-release-verifier-'));
  roots.push(workspace);
  const runRoot = join(workspace, 'test-results', 'luna-high', 'fresh-run');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const controlHashes = {};
  for (const path of controls) {
    const absolute = join(workspace, path);
    await mkdir(dirname(absolute), { recursive: true });
    const bytes = Buffer.from(`control:${path}\n`);
    await writeFile(absolute, bytes);
    controlHashes[path] = sha256(bytes);
  }
  const sourceInputs = {
    scope: 'manifest-authorized-clean-commit',
    rootWasEnumerated: false,
    protectedRootsAccessed: false,
    gitHead: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    sourceManifestSha256: 'C'.repeat(64),
    workspaceInputFiles: 3,
    workspaceInputsSha256: 'D'.repeat(64),
  };
  const observedStages = [];
  for (let index = 0; index < stages.length; index += 1) {
    const [id, kind, command] = stages[index];
    if (kind === 'internal-observation') {
      observedStages.push({ id, kind, exitCode: 0 });
      continue;
    }
    const logRoot = join(runRoot, 'observations');
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const stdoutPath = join(logRoot, `${index}-stdout.log`);
    const stderrPath = join(logRoot, `${index}-stderr.log`);
    const stdoutBytes = Buffer.from(`${id}\n`);
    const stderrBytes = Buffer.alloc(0);
    await writeFile(stdoutPath, stdoutBytes, { mode: 0o600 });
    await writeFile(stderrPath, stderrBytes, { mode: 0o600 });
    observedStages.push({
      id,
      kind,
      command,
      exitCode: 0,
      signal: null,
      stdout: { path: `observations/${index}-stdout.log`, bytes: stdoutBytes.length, sha256: sha256(stdoutBytes) },
      stderr: { path: `observations/${index}-stderr.log`, bytes: 0, sha256: sha256(stderrBytes) },
    });
  }
  const packageManifestPath = join(runRoot, 'package-subject.json');
  await writeFile(packageManifestPath, '{}\n', { mode: 0o600 });
  const runLeasePath = join(runRoot, 'run-lease.json');
  const rootInfo = await lstat(runRoot);
  const protectedRunRootIdentity = { version: 1, canonicalPath: await realpath(runRoot), device: String(rootInfo.dev), inode: String(rootInfo.ino) };
  const runLeaseBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'aimuse-formal-run-lease', protectedRunRootIdentity })}\n`);
  await writeFile(runLeasePath, runLeaseBytes, { mode: 0o600 });
  const observations = {
    schemaVersion: 1,
    kind: 'aimuse-formal-release-observations',
    createdAt: new Date(0).toISOString(),
    acceptanceVerdict: null,
    level: 2,
    protectedRunRoot: {
      path: 'test-results/luna-high/fresh-run',
      identity: protectedRunRootIdentity,
      owner: 'launching-user',
      allowedPrincipals: ['launching-user'],
    },
    runLease: { path: 'run-lease.json', bytes: runLeaseBytes.length, sha256: sha256(runLeaseBytes) },
    sourceInputs,
    packageSubject: { manifestPath: 'package-subject.json', manifestSha256: 'E'.repeat(64), subjectIdentitySha256: 'F'.repeat(64) },
    controls: controlHashes,
    stages: observedStages,
  };
  const observationPath = join(runRoot, 'automation-observations.json');
  const writeObservations = async () => {
    const bytes = Buffer.from(`${JSON.stringify(observations, null, 2)}\n`);
    await writeFile(observationPath, bytes, { mode: 0o600 });
    await chmod(observationPath, 0o600);
    return sha256(bytes);
  };
  const verifierSha256 = sha256(await readFile(resolve('scripts/release-evidence-verifier.mjs')));
  const verifyPackageSubject = async () => ({
    assertions: {
      requiredRuntimeEntries: true,
      minimumComponentSizes: true,
      exactMcpToolSurface: true,
      providerFreeProductBoundary: true,
      rendererAuthorityIsolation: true,
      macosBundleContract: true,
      repoOwnedIcon: true,
      deepStrictSignature: true,
    },
    manifest: {
      inputs: sourceInputs,
      subject: {
        identitySha256: 'F'.repeat(64),
        packageDirectory: 'test-results/luna-high/fresh-run/package-output/AIMuse-darwin-arm64',
        architecture: 'arm64',
        signature: { kind: 'ad-hoc' },
        files: { applicationExecutable: { sha256: '1'.repeat(64) }, applicationAsar: { sha256: '2'.repeat(64) } },
      },
    },
  });
  return { workspace, runRoot, observationPath, observations, writeObservations, verifierSha256, verifyPackageSubject };
}

describe('independent release evidence verifier', () => {
  it('derives acceptance only from exact fresh observations and caller-pinned verifier bytes', async () => {
    const value = await fixture();
    const observationSha256 = await value.writeObservations();
    await expect(verifyReleaseEvidence({
      workspace: value.workspace,
      formalRunRoot: value.runRoot,
      observationManifestPath: value.observationPath,
      expectedObservationManifestSha256: observationSha256,
      expectedVerifierSha256: value.verifierSha256,
    }, { verifyPackageSubject: value.verifyPackageSubject })).resolves.toMatchObject({
      verdict: 'PASS',
      checks: expect.arrayContaining([{ id: 'producer-has-no-acceptance-verdict', satisfied: true }]),
    });
  });

  it('rejects producer-authored acceptance and weakened commands', async () => {
    const value = await fixture();
    value.observations.acceptanceVerdict = 'PASS';
    let digest = await value.writeObservations();
    await expect(verifyReleaseEvidence({
      workspace: value.workspace,
      formalRunRoot: value.runRoot,
      observationManifestPath: value.observationPath,
      expectedObservationManifestSha256: digest,
      expectedVerifierSha256: value.verifierSha256,
    }, { verifyPackageSubject: value.verifyPackageSubject })).rejects.toThrow(/stored its own acceptance/u);

    value.observations.acceptanceVerdict = null;
    value.observations.stages.find((stage) => stage.id === 'verify-source').command = ['npm', 'run', 'typecheck'];
    digest = await value.writeObservations();
    await expect(verifyReleaseEvidence({
      workspace: value.workspace,
      formalRunRoot: value.runRoot,
      observationManifestPath: value.observationPath,
      expectedObservationManifestSha256: digest,
      expectedVerifierSha256: value.verifierSha256,
    }, { verifyPackageSubject: value.verifyPackageSubject })).rejects.toThrow(/weakened or changed/u);
  });
});
