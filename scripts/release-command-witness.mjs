import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const RECEIPT_SCHEMA_VERSION = 2;

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
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
async function publishExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite witnessed execution evidence: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}
async function assertFileIdentity(declaration, label) {
  if (!declaration || typeof declaration !== 'object' || !isAbsolute(declaration.canonicalPath ?? '')) throw new Error(`${label} declaration is invalid.`);
  const canonical = await realpath(declaration.requestedPath);
  if (canonical !== declaration.canonicalPath) throw new Error(`${label} canonical path drifted.`);
  const info = await stat(canonical);
  if (!info.isFile() || info.size !== declaration.bytes || await sha256File(canonical) !== assertSha256(declaration.sha256, `${label} digest`)) throw new Error(`${label} bytes drifted from declared inputs.`);
  return canonical;
}
function stagePlan(contract, level) {
  if (contract?.schemaVersion !== 2 || contract.kind !== 'aimuse-formal-release-contract' || !Array.isArray(contract.stages?.base) || !Array.isArray(contract.schemaFields?.executionReceiptBase)) throw new Error('Formal release contract schema is unsupported.');
  if (level === 1) return [...contract.stages.base];
  if (level === 2 && Array.isArray(contract.stages.level2)) return [...contract.stages.base, ...contract.stages.level2];
  throw new Error(`Formal release contract does not support Level ${level}.`);
}
function parseCli(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return values;
}
function required(values, key) { const value = values.get(key); if (!value) throw new Error(`--${key} is required.`); return value; }
function environmentFor(inputs, subject) {
  const environment = {
    ...inputs.executionEnvironment,
    AIMUSE_FORMAL_RUN_ROOT: inputs.paths.formalRunRoot,
    AIMUSE_FORGE_OUT_DIR: inputs.paths.forgeOutDirectory,
    AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR: inputs.paths.packagedPlaywrightOutput,
    AIMUSE_RENDERER_PLAYWRIGHT_OUTPUT_DIR: inputs.paths.rendererPlaywrightOutput,
    AIMUSE_NPM_CLI: inputs.toolchain.externalTools.npm.canonicalPath,
  };
  delete environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  delete environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  if (subject) {
    environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST = subject.path;
    environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256 = subject.sha256;
  }
  return environment;
}
function declaredEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}
async function runObserved(command, arguments_, options) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = new Date();
    const startedMonotonic = performance.now();
    const child = spawn(command, arguments_, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => { stdout.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr.push(chunk); process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolvePromise({
      childPid: child.pid,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round((performance.now() - startedMonotonic) * 1000) / 1000),
      exitCode: exitCode ?? 1,
      signal: signal ?? null,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
}

export async function witnessReleaseCommand({
  stageId, declaredInputsPath, expectedDeclaredInputsSha256, packageSubjectPath,
  expectedPackageSubjectSha256, execute = runObserved, publish = publishExclusive,
} = {}) {
  if (!stageId || !declaredInputsPath || !expectedDeclaredInputsSha256) throw new Error('Stage and declared input binding are required.');
  const inputPath = resolve(declaredInputsPath);
  const inputBytes = await readFile(inputPath);
  const inputDigest = sha256Bytes(inputBytes);
  if (inputDigest !== assertSha256(expectedDeclaredInputsSha256, 'Declared release input digest')) throw new Error('Declared release input bytes drifted before witnessed execution.');
  const inputs = JSON.parse(inputBytes.toString('utf8'));
  if (inputs?.schemaVersion !== 2 || inputs.kind !== 'aimuse-declared-release-inputs' || inputs.acceptanceVerdict !== null) throw new Error('Declared release input schema is unsupported.');
  const runRoot = resolve(inputs.paths?.formalRunRoot ?? '');
  const workspace = resolve(inputs.paths?.workspace ?? '');
  if (!strictChild(runRoot, inputPath) || !strictChild(workspace, runRoot)) throw new Error('Declared release inputs escaped their workspace/run boundary.');
  const contractPath = resolve(workspace, inputs.contract?.path ?? '');
  const contractBytes = await readFile(contractPath);
  if (contractBytes.length !== inputs.contract?.bytes || sha256Bytes(contractBytes) !== assertSha256(inputs.contract?.sha256, 'Release contract digest')) throw new Error('Formal release contract drifted from declared inputs.');
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const plan = stagePlan(contract, inputs.level);
  const stageIndex = plan.findIndex((stage) => stage.id === stageId);
  if (stageIndex < 0) throw new Error(`Execution stage is not declared for Level ${inputs.level}: ${stageId}`);
  const stage = plan[stageIndex];
  const witnessPath = fileURLToPath(import.meta.url);
  const witnessDeclaration = inputs.controls?.['scripts/release-command-witness.mjs'];
  const [nodePath, npmPath, witnessCanonicalPath] = await Promise.all([
    assertFileIdentity(inputs.toolchain?.externalTools?.node, 'Node executable'),
    assertFileIdentity(inputs.toolchain?.externalTools?.npm, 'npm CLI'),
    assertFileIdentity(witnessDeclaration, 'Execution witness'),
  ]);
  if (await realpath(witnessPath) !== witnessCanonicalPath) throw new Error('The running execution witness is not the declared witness file.');
  let subject;
  if (stage.packageSubjectRequired) {
    if (!packageSubjectPath || !expectedPackageSubjectSha256) throw new Error(`Stage ${stageId} requires the frozen package subject binding.`);
    const selected = resolve(packageSubjectPath);
    if (selected !== resolve(inputs.paths.packageSubjectManifest)) throw new Error('Witnessed stage package manifest differs from declared inputs.');
    const bytes = await readFile(selected);
    const digest = sha256Bytes(bytes);
    if (digest !== assertSha256(expectedPackageSubjectSha256, 'Package subject digest')) throw new Error('Package subject bytes drifted before witnessed execution.');
    subject = { path: selected, sha256: digest };
  } else if (packageSubjectPath || expectedPackageSubjectSha256) {
    throw new Error(`Pre-subject stage ${stageId} may not receive a package subject binding.`);
  }
  let command;
  let arguments_;
  if (stage.command?.type === 'npm-script') {
    command = nodePath;
    arguments_ = [npmPath, 'run', stage.command.name];
  } else if (stage.command?.type === 'node-script') {
    command = nodePath;
    const scriptPath = resolve(workspace, stage.command.path);
    if (!strictChild(workspace, scriptPath)) throw new Error(`Declared node script escaped the workspace: ${stage.command.path}`);
    const sourceEntry = inputs.sourceInputs?.entries?.find((entry) => entry.path === stage.command.path);
    if (!sourceEntry || await sha256File(scriptPath) !== assertSha256(sourceEntry.sha256, `Source entry ${stage.command.path}`)) throw new Error(`Declared node script drifted from clean source inputs: ${stage.command.path}`);
    arguments_ = [stage.command.path];
  } else {
    throw new Error(`Unsupported release command type for ${stageId}.`);
  }
  const environment = environmentFor(inputs, subject);
  const observed = await execute(command, arguments_, { cwd: workspace, env: environment });
  const prefix = `${String(stageIndex + 1).padStart(2, '0')}-${stageId}`;
  const stdoutArtifact = await publish(join(runRoot, 'execution', `${prefix}.stdout.log`), observed.stdout);
  const stderrArtifact = await publish(join(runRoot, 'execution', `${prefix}.stderr.log`), observed.stderr);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: 'aimuse-witnessed-command-execution',
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    stageId,
    declaredInputs: { path: posixRelative(runRoot, inputPath), sha256: inputDigest },
    contract: { path: inputs.contract.path, sha256: inputs.contract.sha256 },
    attribution: {
      witnessPath: posixRelative(workspace, witnessCanonicalPath),
      witnessSha256: witnessDeclaration.sha256,
      witnessPid: process.pid,
      childPid: observed.childPid,
    },
    command: {
      logical: stage.command,
      executable: inputs.toolchain.externalTools.node,
      arguments: arguments_.map((value) => value === npmPath ? inputs.toolchain.externalTools.npm.requestedPath : value),
    },
    environment: declaredEnvironment(environment),
    timing: { startedAt: observed.startedAt, finishedAt: observed.finishedAt, durationMs: observed.durationMs },
    termination: { exitCode: observed.exitCode, signal: observed.signal },
    stdout: { path: posixRelative(runRoot, stdoutArtifact.path), bytes: stdoutArtifact.bytes, sha256: stdoutArtifact.sha256 },
    stderr: { path: posixRelative(runRoot, stderrArtifact.path), bytes: stderrArtifact.bytes, sha256: stderrArtifact.sha256 },
    ...(subject ? { packageSubject: { path: posixRelative(runRoot, subject.path), sha256: subject.sha256 } } : {}),
  };
  assertContractFields(receipt, [
    ...contract.schemaFields.executionReceiptBase,
    ...(subject ? contract.schemaFields.executionReceiptPackageExtension : []),
  ], 'Execution receipt');
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptArtifact = await publish(join(runRoot, 'execution', `${prefix}.receipt.json`), receiptBytes);
  return { receipt, receiptPath: receiptArtifact.path, receiptSha256: receiptArtifact.sha256 };
}

async function main() {
  const values = parseCli(process.argv.slice(2));
  const result = await witnessReleaseCommand({
    stageId: required(values, 'stage'),
    declaredInputsPath: required(values, 'declared-inputs'),
    expectedDeclaredInputsSha256: required(values, 'expected-declared-inputs-sha256'),
    packageSubjectPath: values.get('package-subject'),
    expectedPackageSubjectSha256: values.get('expected-package-subject-sha256'),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    kind: 'aimuse-witnessed-command-reference',
    acceptanceVerdict: null,
    stageId: result.receipt.stageId,
    receiptPath: result.receiptPath,
    receiptSha256: result.receiptSha256,
    termination: result.receipt.termination,
  }, null, 2)}\n`);
  if (result.receipt.termination.exitCode !== 0 || result.receipt.termination.signal !== null) process.exitCode = result.receipt.termination.exitCode || 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse release command witness failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
