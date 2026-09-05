import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  assertSourceInputsStable,
  captureSourceInputs,
  createPackageSubject,
  sha256File,
} from './package-subject.mjs';
import { inspectProtectedDirectory, inspectProtectedRunRoot } from './release-protected-root-verifier.mjs';

const contractUrl = new URL('./formal-release-contract.json', import.meta.url);

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[A-F\d]{64}$/iu.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value.toUpperCase();
}
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function posixRelative(root, candidate) { return relative(root, candidate).split(sep).join('/'); }
function assertContractFields(value, fields, label) {
  if (!Array.isArray(fields) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) throw new Error(`${label} fields disagree with the formal release contract.`);
}
function sameRootIdentity(left, right) {
  return left?.identity?.canonicalPath === right?.identity?.canonicalPath && left?.identity?.device === right?.identity?.device && left?.identity?.inode === right?.identity?.inode;
}
function parseContract(bytes) {
  const contract = JSON.parse(bytes.toString('utf8'));
  if (contract?.schemaVersion !== 2 || contract.kind !== 'aimuse-formal-release-contract' || contract.schemas?.automationObservations !== 2 || !Array.isArray(contract.schemaFields?.automationObservations)) throw new Error('Formal release contract schema is unsupported.');
  return contract;
}
function stagesFor(contract, level) {
  if (level === 1) return [...contract.stages.base];
  if (level === 2) return [...contract.stages.base, ...contract.stages.level2];
  throw new Error('Formal package workflow level must be 1 or 2.');
}

export function formalWorkflowStages(level) {
  return stagesFor(parseContract(readFileSync(contractUrl)), level).map((stage) => stage.id);
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
async function assertMissing(path, label) {
  try { await lstat(path); throw new Error(`${label} already exists; formal package inputs require a fresh destination.`); }
  catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return; throw error; }
}
async function spawnWitness({ workspace, stageId, declaredInputsPath, declaredInputsSha256, packageSubject }) {
  const arguments_ = [
    'scripts/release-command-witness.mjs',
    '--stage', stageId,
    '--declared-inputs', declaredInputsPath,
    '--expected-declared-inputs-sha256', declaredInputsSha256,
    ...(packageSubject ? ['--package-subject', packageSubject.path, '--expected-package-subject-sha256', packageSubject.sha256] : []),
  ];
  const outcome = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: workspace, env: process.env, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolvePromise({ exitCode: exitCode ?? 1, signal: signal ?? null }));
  });
  if (outcome.exitCode !== 0 || outcome.signal !== null) throw new Error(`Witnessed release stage ${stageId} failed with ${outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`}.`);
}
async function declaredInputsFrom({ workspace, environment, read = readFile }) {
  const manifestValue = environment.AIMUSE_RELEASE_INPUTS_MANIFEST;
  const digestValue = environment.AIMUSE_RELEASE_INPUTS_SHA256;
  if (!manifestValue || !isAbsolute(manifestValue)) throw new Error('AIMUSE_RELEASE_INPUTS_MANIFEST must name the caller-created absolute declared-input manifest.');
  const path = resolve(manifestValue);
  const bytes = await read(path);
  const digest = sha256Bytes(bytes);
  if (digest !== assertSha256(digestValue, 'AIMUSE_RELEASE_INPUTS_SHA256')) throw new Error('Declared release input manifest bytes drifted before automation.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest?.schemaVersion !== 2 || manifest.kind !== 'aimuse-declared-release-inputs' || manifest.acceptanceVerdict !== null) throw new Error('Declared release input manifest schema is unsupported.');
  if (resolve(manifest.paths?.workspace ?? '') !== resolve(workspace)) throw new Error('Declared release input workspace does not match automation.');
  return { path, bytes, digest, manifest };
}
async function readWitnessReceipt({ runRoot, stage, stageIndex, declaredInputs, read = readFile, hash = sha256File }) {
  const prefix = `${String(stageIndex + 1).padStart(2, '0')}-${stage.id}`;
  const path = join(runRoot, 'execution', `${prefix}.receipt.json`);
  const bytes = await read(path);
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (receipt?.schemaVersion !== 2 || receipt.kind !== 'aimuse-witnessed-command-execution' || receipt.stageId !== stage.id || receipt.acceptanceVerdict !== null) throw new Error(`Witness receipt schema or stage identity is invalid: ${stage.id}`);
  if (receipt.declaredInputs?.sha256 !== declaredInputs.digest || resolve(runRoot, receipt.declaredInputs?.path ?? '') !== declaredInputs.path) throw new Error(`Witness receipt is not bound to declared inputs: ${stage.id}`);
  return { stageId: stage.id, path: posixRelative(runRoot, path), bytes: bytes.length, sha256: await hash(path) };
}

export async function runFormalPackageWorkflow({
  level,
  workspace = process.cwd(),
  environment = process.env,
  captureInputs = captureSourceInputs,
  createSubject = createPackageSubject,
  inspectRunRoot = inspectProtectedRunRoot,
  inspectExecutionTemp = inspectProtectedDirectory,
  publishArtifact = publishExclusive,
  executeWitness = spawnWitness,
  loadDeclaredInputs = declaredInputsFrom,
  loadWitnessReceipt = readWitnessReceipt,
  assertFreshWorkspaceBuild = assertMissing,
} = {}) {
  const root = resolve(workspace);
  const declared = await loadDeclaredInputs({ workspace: root, environment });
  if (declared.manifest.level !== level) throw new Error(`Declared release inputs are for Level ${declared.manifest.level}, not Level ${level}.`);
  const contractPath = resolve(root, declared.manifest.contract?.path ?? '');
  const contractBytes = await readFile(contractPath);
  if (contractBytes.length !== declared.manifest.contract?.bytes || sha256Bytes(contractBytes) !== assertSha256(declared.manifest.contract?.sha256, 'Declared release contract digest')) throw new Error('Formal release contract drifted after input declaration.');
  const contract = parseContract(contractBytes);
  const stages = stagesFor(contract, level);
  const runRoot = resolve(declared.manifest.paths.formalRunRoot);
  const forgeOut = resolve(declared.manifest.paths.forgeOutDirectory);
  const packageManifestPath = resolve(declared.manifest.paths.packageSubjectManifest);
  const workspaceViteOutputDirectory = resolve(declared.manifest.paths.workspaceViteOutputDirectory ?? '');
  if (!strictChild(resolve(root, 'test-results', 'luna-high'), runRoot) || !strictChild(runRoot, forgeOut) || !strictChild(runRoot, packageManifestPath) || !strictChild(runRoot, declared.path)) throw new Error('Declared formal release paths escape their manifest-bounded run root.');
  if (workspaceViteOutputDirectory !== join(root, '.vite')) throw new Error('Declared workspace Vite output must be the exact Forge Vite staging directory.');
  for (const [key, expected] of [
    ['AIMUSE_FORMAL_RUN_ROOT', runRoot],
    ['AIMUSE_FORGE_OUT_DIR', forgeOut],
    ['AIMUSE_PACKAGE_SUBJECT_MANIFEST', packageManifestPath],
    ['AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR', resolve(declared.manifest.paths.packagedPlaywrightOutput)],
  ]) {
    if (!environment[key] || resolve(environment[key]) !== expected) throw new Error(`${key} does not match the caller-declared release inputs.`);
  }
  await Promise.all([
    assertMissing(forgeOut, 'Formal Forge output'),
    assertMissing(packageManifestPath, 'Package subject manifest'),
    assertMissing(join(runRoot, 'run-lease.json'), 'Formal run lease'),
    assertMissing(join(runRoot, 'automation-observations.json'), 'Automation observations'),
    assertMissing(join(runRoot, 'execution'), 'Witnessed execution directory'),
    assertFreshWorkspaceBuild(workspaceViteOutputDirectory, 'Workspace Vite output'),
  ]);
  const initialRoot = await inspectRunRoot({ workspace: root, formalRunRoot: runRoot });
  if (JSON.stringify(initialRoot.identity) !== JSON.stringify(declared.manifest.protectedRunRoot?.identity)) throw new Error('Protected formal run-root identity drifted after input declaration.');
  const initialExecutionTemp = await inspectExecutionTemp({ directory: declared.manifest.paths.executionTemp });
  if (JSON.stringify(initialExecutionTemp.identity) !== JSON.stringify(declared.manifest.protectedExecutionTemp?.identity)) throw new Error('Protected execution temporary-directory identity drifted after input declaration.');
  const runLeaseArtifact = await publishArtifact(join(runRoot, 'run-lease.json'), Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    kind: 'aimuse-formal-run-lease',
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    declaredInputsSha256: declared.digest,
    protectedRunRootIdentity: initialRoot.identity,
  }, null, 2)}\n`));
  const assertBoundariesStable = async () => {
    const observed = await inspectRunRoot({ workspace: root, formalRunRoot: runRoot });
    if (!sameRootIdentity(initialRoot, observed)) throw new Error('Protected formal run-root identity changed during automation.');
    const observedExecutionTemp = await inspectExecutionTemp({ directory: declared.manifest.paths.executionTemp });
    if (!sameRootIdentity(initialExecutionTemp, observedExecutionTemp)) throw new Error('Protected execution temporary-directory identity changed during automation.');
  };
  const sourceCaptureOptions = {
    gitPath: declared.manifest.toolchain?.externalTools?.git?.canonicalPath,
    gitEnvironment: declared.manifest.executionEnvironment,
  };
  const observedInputs = await captureInputs(root, sourceCaptureOptions);
  assertSourceInputsStable(declared.manifest.sourceInputs, observedInputs);
  const receipts = [];
  let packageSubject;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    await assertBoundariesStable();
    if (stage.packageSubjectRequired && !packageSubject) {
      assertSourceInputsStable(declared.manifest.sourceInputs, await captureInputs(root, sourceCaptureOptions));
      const created = await createSubject({
        workspace: root,
        manifestPath: packageManifestPath,
        formalRunRoot: runRoot,
        sourceInputs: declared.manifest.sourceInputs,
        platform: process.platform,
        architecture: declared.manifest.paths.architecture,
        outDirectory: forgeOut,
      });
      packageSubject = {
        path: created.manifestPath,
        sha256: created.manifestSha256,
        identitySha256: created.manifest.subject.identitySha256,
        subject: created.manifest.subject,
      };
    }
    await executeWitness({
      workspace: root,
      stageId: stage.id,
      declaredInputsPath: declared.path,
      declaredInputsSha256: declared.digest,
      packageSubject: stage.packageSubjectRequired ? packageSubject : undefined,
    });
    receipts.push(await loadWitnessReceipt({ runRoot, stage, stageIndex: index, declaredInputs: declared }));
  }
  if (!packageSubject) throw new Error('Formal workflow did not freeze a package subject.');
  assertSourceInputsStable(declared.manifest.sourceInputs, await captureInputs(root, sourceCaptureOptions));
  await assertBoundariesStable();
  const observations = {
    schemaVersion: 2,
    kind: 'aimuse-formal-release-automation-observations',
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    releasePhase: 'AUTOMATION_COMPLETE_AWAITING_INDEPENDENT_VERIFICATION',
    level,
    protectedRunRoot: {
      path: posixRelative(root, runRoot),
      identity: initialRoot.identity,
      owner: initialRoot.owner,
      allowedPrincipals: initialRoot.allowedPrincipals,
    },
    runLease: { path: posixRelative(runRoot, runLeaseArtifact.path), bytes: runLeaseArtifact.bytes, sha256: runLeaseArtifact.sha256 },
    declaredInputs: { path: posixRelative(runRoot, declared.path), bytes: declared.bytes.length, sha256: declared.digest },
    packageSubject: {
      path: posixRelative(runRoot, packageSubject.path),
      sha256: packageSubject.sha256,
      identitySha256: packageSubject.identitySha256,
    },
    executionReceipts: receipts,
  };
  assertContractFields(observations, contract.schemaFields.automationObservations, 'Automation observation');
  const artifact = await publishArtifact(join(runRoot, 'automation-observations.json'), Buffer.from(`${JSON.stringify(observations, null, 2)}\n`));
  await assertBoundariesStable();
  return {
    level,
    inputs: declared.manifest,
    declaredInputsPath: declared.path,
    declaredInputsSha256: declared.digest,
    manifestPath: packageSubject.path,
    manifestSha256: packageSubject.sha256,
    subjectIdentitySha256: packageSubject.identitySha256,
    subject: packageSubject.subject,
    observationManifestPath: artifact.path,
    observationManifestSha256: artifact.sha256,
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
    schemaVersion: 2,
    kind: 'aimuse-formal-release-automation-reference',
    acceptanceVerdict: null,
    releasePhase: 'AUTOMATION_COMPLETE_AWAITING_INDEPENDENT_VERIFICATION',
    level: result.level,
    declaredInputsPath: result.declaredInputsPath,
    declaredInputsSha256: result.declaredInputsSha256,
    packageSubjectManifestPath: result.manifestPath,
    packageSubjectManifestSha256: result.manifestSha256,
    subjectIdentitySha256: result.subjectIdentitySha256,
    observationManifestPath: result.observationManifestPath,
    observationManifestSha256: result.observationManifestSha256,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse formal package workflow failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
