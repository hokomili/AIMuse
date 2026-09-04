import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  assertSourceInputsStable,
  captureSourceInputs,
  createPackageSubject,
  resolveSubjectManifestPath,
  sha256File,
} from './package-subject.mjs';
import { verifyPackageSubject } from './package-subject-verifier.mjs';
import { assertOwnerPrivateRoot } from './qa-private-root.mjs';

export function formalWorkflowStages(level) {
  if (level !== 1 && level !== 2) throw new Error('Formal package workflow level must be 1 or 2.');
  return [
    'capture-source-inputs',
    'verify-source',
    'native-test',
    'package-preflight',
    'package-artifact-once',
    'confirm-source-inputs',
    'create-subject-manifest',
    'verify-subject-before-verifier',
    'verify-package-from-subject',
    'verify-subject-after-verifier',
    ...(level === 2 ? ['verify-subject-at-e2e-handoff', 'packaged-e2e-from-subject', 'verify-subject-after-e2e'] : []),
  ];
}

function npmInvocation(environment) {
  const npmCli = environment.npm_execpath || environment.AIMUSE_NPM_CLI;
  if (!npmCli || !isAbsolute(npmCli)) throw new Error('Formal automation requires an absolute npm_execpath or AIMUSE_NPM_CLI.');
  return { command: process.execPath, prefix: [resolve(npmCli)] };
}
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function spawnObserved(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ exitCode: code ?? 1, signal: signal ?? null, stdout, stderr }));
  });
}

async function publishExclusive(path, bytes) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite formal evidence: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function sameRootIdentity(left, right) {
  return left?.identity?.canonicalPath === right?.identity?.canonicalPath && left?.identity?.device === right?.identity?.device && left?.identity?.inode === right?.identity?.inode;
}

function relativeEvidencePath(root, path) {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`Formal evidence path escapes its protected run root: ${path}`);
  return value.split(sep).join('/');
}

function strictChild(root, path) {
  const value = relative(root, path);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists; formal package inputs require a fresh run root.`);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

export async function runFormalPackageWorkflow({
  level,
  workspace = process.cwd(),
  environment = process.env,
  runCommand = spawnObserved,
  captureInputs = captureSourceInputs,
  createSubject = createPackageSubject,
  verifySubject = verifyPackageSubject,
  inspectRunRoot = assertOwnerPrivateRoot,
  publishArtifact = publishExclusive,
  hashControl = sha256File,
} = {}) {
  formalWorkflowStages(level);
  const root = resolve(workspace);
  const formalRunRootValue = environment.AIMUSE_FORMAL_RUN_ROOT;
  if (!formalRunRootValue || !isAbsolute(formalRunRootValue)) throw new Error('AIMUSE_FORMAL_RUN_ROOT must be an explicit absolute protected run root.');
  const formalRunRoot = resolve(formalRunRootValue);
  const forgeOutValue = environment.AIMUSE_FORGE_OUT_DIR;
  if (!forgeOutValue || !isAbsolute(forgeOutValue) || !strictChild(formalRunRoot, resolve(forgeOutValue))) {
    throw new Error('AIMUSE_FORGE_OUT_DIR must be an explicit strict child of the protected formal run root.');
  }
  await assertMissing(resolve(forgeOutValue), 'Formal Forge output');
  await assertMissing(join(formalRunRoot, 'run-lease.json'), 'Formal run lease');
  await assertMissing(join(formalRunRoot, 'automation-observations.json'), 'Automation observation manifest');
  await assertMissing(join(formalRunRoot, 'observations'), 'Automation observation directory');
  const configuredManifestPath = environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const manifestPath = resolveSubjectManifestPath({ workspace: root, manifestPath: configuredManifestPath, formalRunRoot });
  await assertMissing(manifestPath, 'Package subject manifest');
  const inspectRoot = () => inspectRunRoot({ privateRoot: formalRunRoot, paths: [formalRunRoot], evidenceRoot: resolve(root, 'test-results') });
  const initialRoot = await inspectRoot();
  const runLeaseArtifact = await publishArtifact(join(formalRunRoot, 'run-lease.json'), Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'aimuse-formal-run-lease',
    createdAt: new Date().toISOString(),
    protectedRunRootIdentity: initialRoot.identity,
  }, null, 2)}\n`));
  const assertRunRootStable = async () => {
    const observed = await inspectRoot();
    if (!sameRootIdentity(initialRoot, observed)) throw new Error('The protected formal run-root identity changed during automation.');
    return observed;
  };
  const stageFacts = [];
  const recordInternal = async (id) => {
    await assertRunRootStable();
    stageFacts.push({ id, kind: 'internal-observation', exitCode: 0 });
  };
  const execute = async (id, command, arguments_, options) => {
    await assertRunRootStable();
    const observed = await runCommand(command, arguments_, options) ?? { exitCode: 0, signal: null, stdout: '', stderr: '' };
    const index = String(stageFacts.length + 1).padStart(2, '0');
    const safeId = id.replaceAll(/[^a-z0-9-]/gu, '-');
    const stdoutPath = join(formalRunRoot, 'observations', `${index}-${safeId}.stdout.log`);
    const stderrPath = join(formalRunRoot, 'observations', `${index}-${safeId}.stderr.log`);
    const [stdout, stderr] = await Promise.all([
      publishArtifact(stdoutPath, Buffer.from(observed.stdout ?? '')),
      publishArtifact(stderrPath, Buffer.from(observed.stderr ?? '')),
    ]);
    const fact = {
      id,
      kind: 'command-observation',
      command: [command, ...arguments_],
      exitCode: observed.exitCode ?? 0,
      signal: observed.signal ?? null,
      stdout: { path: relativeEvidencePath(formalRunRoot, stdout.path), bytes: stdout.bytes, sha256: stdout.sha256 },
      stderr: { path: relativeEvidencePath(formalRunRoot, stderr.path), bytes: stderr.bytes, sha256: stderr.sha256 },
    };
    stageFacts.push(fact);
    await assertRunRootStable();
    if (fact.exitCode !== 0 || fact.signal !== null) throw new Error(`${options.label || command} failed with ${fact.signal ? `signal ${fact.signal}` : `exit code ${fact.exitCode}`}.`);
  };

  const sourceInputs = await captureInputs(root);
  await recordInternal('capture-source-inputs');
  // A caller may select the future manifest destination, but no subject exists
  // until packaging finishes. Keep both binding variables out of all
  // pre-subject subprocesses so ordinary tests cannot observe a half-bound
  // manifest contract. A stale caller digest is never reused.
  const preSubjectEnvironment = { ...environment };
  delete preSubjectEnvironment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  delete preSubjectEnvironment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  const common = { cwd: root, env: preSubjectEnvironment };
  const npm = npmInvocation(preSubjectEnvironment);
  await execute('verify-source', npm.command, [...npm.prefix, 'run', 'verify'], { ...common, label: 'source verification' });
  await execute('native-test', npm.command, [...npm.prefix, 'run', 'native:test'], { ...common, label: 'native tests' });
  await execute('package-preflight', npm.command, [...npm.prefix, 'run', 'prepackage'], { ...common, label: 'package preflight/build' });
  await execute('package-artifact-once', npm.command, [...npm.prefix, 'run', 'package:artifact'], { ...common, label: 'single Forge package creation' });
  assertSourceInputsStable(sourceInputs, await captureInputs(root));
  await recordInternal('confirm-source-inputs');

  const created = await createSubject({
    workspace: root,
    manifestPath,
    formalRunRoot,
    sourceInputs,
    platform: process.platform,
    architecture: environment.AIMUSE_VERIFY_PACKAGE_ARCH || process.arch,
    outDirectory: forgeOutValue,
  });
  await recordInternal('create-subject-manifest');
  const subjectEnvironment = {
    ...preSubjectEnvironment,
    AIMUSE_PACKAGE_SUBJECT_MANIFEST: created.manifestPath,
    AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: created.manifestSha256,
  };
  const verify = (id) => verifySubject({ workspace: root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, formalRunRoot, platform: process.platform }).then(async (result) => { await recordInternal(id); return result; });
  await verify('verify-subject-before-verifier');
  await execute('verify-package-from-subject', process.execPath, ['scripts/verify-package.mjs'], { cwd: root, env: subjectEnvironment, label: 'manifest-bound package verifier' });
  await verify('verify-subject-after-verifier');
  if (level === 2) {
    await verify('verify-subject-at-e2e-handoff');
    await execute('packaged-e2e-from-subject', npm.command, [...npm.prefix, 'run', 'test:e2e:only'], { cwd: root, env: subjectEnvironment, label: 'manifest-bound packaged E2E' });
    await verify('verify-subject-after-e2e');
  }
  const controls = {};
  for (const path of ['scripts/initial-snapshot-manifest.json', 'scripts/formal-package-workflow.mjs', 'scripts/package-subject.mjs', 'scripts/package-subject-verifier.mjs', 'scripts/release-evidence-verifier.mjs', 'scripts/release-protected-root-verifier.mjs', 'scripts/verify-package.mjs']) {
    controls[path] = await hashControl(resolve(root, path));
  }
  const observationManifest = {
    schemaVersion: 1,
    kind: 'aimuse-formal-release-observations',
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    level,
    protectedRunRoot: {
      path: relative(root, formalRunRoot).split(sep).join('/'),
      identity: initialRoot.identity,
      owner: initialRoot.owner,
      allowedPrincipals: initialRoot.allowedPrincipals,
    },
    runLease: {
      path: relativeEvidencePath(formalRunRoot, runLeaseArtifact.path),
      bytes: runLeaseArtifact.bytes,
      sha256: runLeaseArtifact.sha256,
    },
    sourceInputs,
    packageSubject: {
      manifestPath: relativeEvidencePath(formalRunRoot, created.manifestPath),
      manifestSha256: created.manifestSha256,
      subjectIdentitySha256: created.manifest.subject.identitySha256,
    },
    controls,
    stages: stageFacts,
  };
  const observationPath = join(formalRunRoot, 'automation-observations.json');
  const observationArtifact = await publishArtifact(observationPath, Buffer.from(`${JSON.stringify(observationManifest, null, 2)}\n`));
  await assertRunRootStable();
  return {
    level,
    inputs: sourceInputs,
    manifestPath: created.manifestPath,
    manifestSha256: created.manifestSha256,
    subjectIdentitySha256: created.manifest.subject.identitySha256,
    subject: created.manifest.subject,
    observationManifestPath: observationArtifact.path,
    observationManifestSha256: observationArtifact.sha256,
  };
}

function parseLevel(arguments_) {
  const value = arguments_.find((argument) => argument.startsWith('--level='))?.slice('--level='.length);
  const level = Number(value);
  if (level !== 1 && level !== 2) throw new Error('Usage: node scripts/formal-package-workflow.mjs --level=1|2');
  return level;
}

async function main() {
  const result = await runFormalPackageWorkflow({ level: parseLevel(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify({
    evidenceKind: 'observations-awaiting-independent-verification',
    acceptanceVerdict: null,
    level: result.level,
    inputs: result.inputs,
    manifestPath: result.manifestPath,
    manifestSha256: result.manifestSha256,
    subjectIdentitySha256: result.subjectIdentitySha256,
    subject: result.subject,
    observationManifestPath: result.observationManifestPath,
    observationManifestSha256: result.observationManifestSha256,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`AIMuse formal package workflow failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
