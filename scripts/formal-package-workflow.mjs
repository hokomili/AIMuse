import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  assertSourceInputsStable,
  captureSourceInputs,
  createPackageSubject,
  resolveSubjectManifestPath,
  verifyPackageSubject,
} from './package-subject.mjs';

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

function npmCommand() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }
async function spawnChecked(command, arguments_, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd: options.cwd, env: options.env, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${options.label || command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`)));
  });
}

export async function runFormalPackageWorkflow({
  level,
  workspace = process.cwd(),
  environment = process.env,
  runCommand = spawnChecked,
  captureInputs = captureSourceInputs,
  createSubject = createPackageSubject,
  verifySubject = verifyPackageSubject,
} = {}) {
  formalWorkflowStages(level);
  const root = resolve(workspace);
  const sourceInputs = await captureInputs(root);
  // A caller may select the future manifest destination, but no subject exists
  // until packaging finishes. Keep both binding variables out of all
  // pre-subject subprocesses so ordinary tests cannot observe a half-bound
  // manifest contract. A stale caller digest is never reused.
  const configuredManifestPath = environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const preSubjectEnvironment = { ...environment };
  delete preSubjectEnvironment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  delete preSubjectEnvironment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  const common = { cwd: root, env: preSubjectEnvironment };
  await runCommand(npmCommand(), ['run', 'verify'], { ...common, label: 'source verification' });
  await runCommand(npmCommand(), ['run', 'native:test'], { ...common, label: 'native tests' });
  await runCommand(npmCommand(), ['run', 'prepackage'], { ...common, label: 'package preflight/build' });
  await runCommand(npmCommand(), ['run', 'package:artifact'], { ...common, label: 'single Forge package creation' });
  assertSourceInputsStable(sourceInputs, await captureInputs(root));

  const manifestPath = resolveSubjectManifestPath({
    workspace: root,
    manifestPath: configuredManifestPath,
    formalRunRoot: environment.AIMUSE_FORMAL_RUN_ROOT,
  });
  const created = await createSubject({
    workspace: root,
    manifestPath,
    formalRunRoot: environment.AIMUSE_FORMAL_RUN_ROOT,
    sourceInputs,
    platform: process.platform,
    architecture: environment.AIMUSE_VERIFY_PACKAGE_ARCH || process.arch,
    outDirectory: environment.AIMUSE_FORGE_OUT_DIR || 'out',
  });
  const subjectEnvironment = {
    ...preSubjectEnvironment,
    AIMUSE_PACKAGE_SUBJECT_MANIFEST: created.manifestPath,
    AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: created.manifestSha256,
  };
  const verify = () => verifySubject({ workspace: root, manifestPath: created.manifestPath, expectedManifestSha256: created.manifestSha256, platform: process.platform });
  await verify();
  await runCommand(process.execPath, ['scripts/verify-package.mjs'], { cwd: root, env: subjectEnvironment, label: 'manifest-bound package verifier' });
  await verify();
  if (level === 2) {
    await verify();
    await runCommand(npmCommand(), ['run', 'test:e2e:only'], { cwd: root, env: subjectEnvironment, label: 'manifest-bound packaged E2E' });
    await verify();
  }
  return {
    level,
    inputs: sourceInputs,
    manifestPath: created.manifestPath,
    manifestSha256: created.manifestSha256,
    subjectIdentitySha256: created.manifest.subject.identitySha256,
    subject: created.manifest.subject,
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
    formalAutomationPassed: true,
    level: result.level,
    inputs: result.inputs,
    manifestPath: result.manifestPath,
    manifestSha256: result.manifestSha256,
    subjectIdentitySha256: result.subjectIdentitySha256,
    subject: result.subject,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`AIMuse formal package workflow failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
