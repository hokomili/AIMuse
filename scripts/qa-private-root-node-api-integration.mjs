import { accessSync, constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { normalizeProviderNativeFailureEvidence, runPrivateRootNodeApiNativeCases } from './qa-private-root-node-api-native-cases.mjs';
import { runPrivateRootNodeApiRenameDiagnostics } from './qa-private-root-node-api-rename-diagnostics.mjs';
import { runPrivateRootNodeApiReplacementIdentityDiagnostics } from './qa-private-root-node-api-replacement-identity-diagnostics.mjs';
import { withNativeExecutionCwd } from './qa-private-root-node-api-execution-cwd.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(workspace, 'test-results');

function executable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return candidates.at(-1);
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') return { help: true };
    if (!['--run-root', '--node-api-root', '--mode'].includes(argument) || index + 1 >= arguments_.length) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[argument.slice(2).replaceAll('-', '_')] = arguments_[index += 1];
  }
  return options;
}

function assertDirectChild(pathValue, label) {
  if (typeof pathValue !== 'string' || !isAbsolute(pathValue)) throw new Error(`${label} must be absolute.`);
  const path = resolve(pathValue);
  if (dirname(path).toUpperCase() !== resolve(evidenceRoot).toUpperCase() || relative(evidenceRoot, path).split(/[\\/]/).length !== 1) {
    throw new Error(`${label} must be one exact direct child of ${evidenceRoot}.`);
  }
  return path;
}

async function mustBeAbsent(path) {
  try {
    await lstat(path);
    throw new Error(`The run root already exists and will not be reused: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function fileIdentity(path) {
  const [canonicalPath, info] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  return { version: 1, canonicalPath: resolve(canonicalPath), device: String(info.dev), inode: String(info.ino) };
}

function run(program, arguments_) {
  const result = spawnSync(program, arguments_, { cwd: workspace, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status ?? 1}.`);
}

function cmakePath() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  return executable([
    process.env.AIMUSE_CMAKE,
    join(programFiles, 'CMake', 'bin', 'cmake.exe'),
    join(programFiles, 'Microsoft Visual Studio', '18', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
    join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
    'cmake.exe',
  ]);
}

function nodeApiInputs(rootValue) {
  if (typeof rootValue !== 'string' || !isAbsolute(rootValue)) throw new Error('The audited Node-API root must be absolute.');
  const root = resolve(rootValue);
  const include = join(root, 'include', 'node');
  const library = join(root, 'x64', 'node.lib');
  const files = [
    join(include, 'node_api.h'),
    join(include, 'node_api_types.h'),
    join(include, 'js_native_api.h'),
    join(include, 'js_native_api_types.h'),
    library,
  ];
  for (const path of files) if (!existsSync(path)) throw new Error(`The audited Node-API input is missing: ${path}`);
  return { root, include, library, files };
}

function reportFor(summary) {
  const replacementIdentityDiagnostics = summary.subject === 'qa10-windows-private-root-node-api-replacement-identity-diagnostics';
  const lines = [
    summary.subject === 'qa10-windows-private-root-node-api-rename-diagnostics'
      ? '# QA-10 Node-API private-root rename diagnostics'
      : replacementIdentityDiagnostics
        ? '# QA-10 Node-API private-root replacement identity diagnostics'
        : '# QA-10 Node-API private-root provider prototype',
    '',
    `Overall: **${summary.outcome}**`,
    '',
    `Run root: \`${summary.runRoot}\``,
    `Run-root identity: device \`${summary.runRootIdentity.device}\`, inode \`${summary.runRootIdentity.inode}\``,
    `Addon: \`${summary.addon?.path ?? 'not built'}\``,
    `Addon SHA-256: \`${summary.addon?.sha256 ?? 'unearned'}\``,
    '',
    '## Cases',
    '',
    ...(summary.native?.cases ?? []).map((entry) => replacementIdentityDiagnostics
      ? `- ${entry.id}: rename Win32 ${entry.renameErrorCode}; while-stage open Win32 ${entry.targetOpenWhileStageErrorCode}; after-close open Win32 ${entry.targetOpenAfterStageCloseErrorCode}`
      : entry.errorCode === undefined
        ? `- ${entry.name ?? entry.id}: ${entry.outcome}`
        : `- ${entry.id}: ${entry.outcome} at ${entry.phase}, Win32 ${entry.errorCode}`),
    ...(summary.nativeFailure?.kind === 'snapshot-open'
      ? [
          '',
          '## Sanitized native discriminator',
          '',
          `- Kind: ${summary.nativeFailure.kind}.`,
          `- Phase: ${summary.nativeFailure.phase}.`,
          `- Win32 code: ${summary.nativeFailure.win32Code}.`,
          `- Shared lease preflight complete: ${summary.nativeFailure.sharedLeasePreflightCompleted}.`,
          `- Provider lease acquired: ${summary.nativeFailure.providerLeaseAcquired}.`,
          `- Provider atomic replace complete: ${summary.nativeFailure.providerAtomicReplaceCompleted}.`,
          `- Concurrent replacement worker active: ${summary.nativeFailure.concurrentReplacementWorkerActive}.`,
        ]
      : summary.nativeFailure?.kind === 'js-authority-acl'
        ? [
            '',
            '## Sanitized native discriminator',
            '',
            `- Kind: ${summary.nativeFailure.kind}.`,
            `- Phase: ${summary.nativeFailure.phase}.`,
            `- Unexpected principal detected: ${summary.nativeFailure.unexpectedPrincipalDetected}.`,
          ]
        : []),
    ...(summary.subject === 'qa10-windows-private-root-node-api-rename-diagnostics' && summary.native
      ? [
          '',
          '## Documented environment',
          '',
          `- FILE_RENAME_INFO: size ${summary.native.structure.fileRenameInfoSize}, FileName offset ${summary.native.structure.fileNameOffset}, alignment ${summary.native.structure.alignment}, wchar ${summary.native.structure.wideCharacterBytes}.`,
          `- Filesystem: ${summary.native.filesystem.name}, maximum component ${summary.native.filesystem.maximumComponentLength}, flags ${summary.native.filesystem.flags}.`,
          `- System: ${summary.native.system.platform} ${summary.native.system.architecture} ${summary.native.system.release}.`,
        ]
      : []),
    '',
    '## Boundaries',
    '',
    '- Conditional provider-only build; no coordinator wiring or runtime/package staging.',
    '- No AIMuse/Electron/browser/native-helper launch, desktop input, Computer Use, credential/provider/network/paid activity or retained-root access.',
    summary.nativeExecutionCwd?.mutationContainmentIndependentlyObserved === true
      ? `- Native addon loading and callbacks ran only inside the owner-private run-owned ${summary.nativeExecutionCwd.relativeName} CWD; identity, stable directory metadata, empty before/after snapshots, zero mutation events and deterministic restoration were independently observed.`
      : '- Native execution CWD containment was not independently established; this run cannot pass.',
    summary.boundaries.providerAuthorityExplicitlyBound === true
      ? '- Provider and diagnostic private-root verification was explicitly bound to the exact run root; ambient CWD and broader authority defaults were not used.'
      : '- Explicit run-root authority was not earned; this run cannot pass provider acceptance.',
    '- No automatic cleanup. This root may be removed only under separate authority after its canonical/device/inode identity matches this report.',
  ];
  if (summary.error) lines.push('', '## Failure', '', summary.error.message);
  return `${lines.join('\n')}\n`;
}

export async function runPrivateRootNodeApiIntegration(options, dependencies = {}) {
  if (process.platform !== 'win32') throw new Error('The private-root Node-API integration requires Windows.');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('The private-root Node-API integration requires the project-pinned Node 24 runtime.');
  const mode = options.mode ?? 'provider';
  if (!['provider', 'rename-diagnostics', 'replacement-identity-diagnostics'].includes(mode)) {
    throw new Error(`Unsupported private-root Node-API integration mode: ${mode}.`);
  }
  const runRoot = assertDirectChild(options.runRoot, 'Run root');
  const nodeApi = nodeApiInputs(options.nodeApiRoot);
  await mustBeAbsent(runRoot);
  await mkdir(runRoot);
  const initialIdentity = await fileIdentity(runRoot);
  const buildRoot = join(runRoot, 'native-build');
  const cmake = dependencies.cmake ?? cmakePath();
  const generator = cmake.includes('\\18\\') ? 'Visual Studio 18 2026' : 'Visual Studio 17 2022';
  const configureArguments = [
    '--fresh', '-S', join(workspace, 'native'), '-B', buildRoot,
    '-G', process.env.AIMUSE_CMAKE_GENERATOR ?? generator, '-A', 'x64',
    '-DAIMUSE_FETCH_AUDIO_DEPS=OFF', '-DAIMUSE_ENABLE_WASAPI=OFF', '-DAIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER=ON',
    `-DAIMUSE_NODE_API_INCLUDE_DIR=${nodeApi.include}`, `-DAIMUSE_NODE_API_LIBRARY=${nodeApi.library}`,
  ];
  const execute = dependencies.run ?? run;
  const nativeCases = dependencies.nativeCases ?? runPrivateRootNodeApiNativeCases;
  const renameDiagnostics = dependencies.renameDiagnostics ?? runPrivateRootNodeApiRenameDiagnostics;
  const replacementIdentityDiagnostics = dependencies.replacementIdentityDiagnostics ?? runPrivateRootNodeApiReplacementIdentityDiagnostics;
  const containNativeExecution = dependencies.withNativeExecutionCwd ?? withNativeExecutionCwd;
  const summary = {
    schemaVersion: 2,
    subject: mode === 'rename-diagnostics'
      ? 'qa10-windows-private-root-node-api-rename-diagnostics'
      : mode === 'replacement-identity-diagnostics'
        ? 'qa10-windows-private-root-node-api-replacement-identity-diagnostics'
        : 'qa10-windows-private-root-node-api-provider',
    outcome: 'BLOCKED',
    runRoot,
    runRootIdentity: initialIdentity,
    node: process.version,
    nodeApiInputs: [],
    boundaries: { applicationLaunches: 0, packageActions: 0, networkCalls: 0, credentialAccesses: 0, retainedRootAccesses: 0, mutationContainmentIndependentlyObserved: false, providerAuthorityExplicitlyBound: false, automaticCleanup: false },
  };
  try {
    for (const path of nodeApi.files) summary.nodeApiInputs.push({ path, size: (await stat(path)).size, sha256: await sha256(path) });
    execute(cmake, configureArguments);
    execute(cmake, ['--build', buildRoot, '--config', 'RelWithDebInfo', '--target', 'aimuse-qa-private-root-provider', '--parallel']);
    const addonPath = join(buildRoot, 'aimuse-qa-private-root-provider.node');
    const addonStat = await stat(addonPath);
    summary.addon = { path: addonPath, size: addonStat.size, sha256: await sha256(addonPath) };
    const nativeExecution = await containNativeExecution({
      runRoot,
      evidenceRoot,
      action: async (executionCwd) => mode === 'rename-diagnostics'
        ? await renameDiagnostics({ runRoot, addonPath, executionCwd })
        : mode === 'replacement-identity-diagnostics'
          ? await replacementIdentityDiagnostics({ runRoot, addonPath, executionCwd })
          : await nativeCases({ runRoot, addonPath, executionCwd }),
    });
    summary.native = nativeExecution.value;
    summary.nativeExecutionCwd = nativeExecution.evidence;
    summary.boundaries.mutationContainmentIndependentlyObserved = nativeExecution.evidence.mutationContainmentIndependentlyObserved;
    if (!summary.boundaries.mutationContainmentIndependentlyObserved) throw new Error('Native execution CWD containment was not independently observed.');
    summary.boundaries.providerAuthorityExplicitlyBound = summary.native?.boundaries?.providerAuthorityExplicitlyBound === true;
    if (!summary.boundaries.providerAuthorityExplicitlyBound) throw new Error('Provider checkpoint authority was not explicitly bound to the run root.');
    const finalIdentity = await fileIdentity(runRoot);
    if (JSON.stringify(finalIdentity) !== JSON.stringify(initialIdentity)) throw new Error('The integration run-root object identity changed.');
    summary.outcome = 'PASS';
    summary.completedAt = new Date().toISOString();
  } catch (error) {
    summary.outcome = 'FAIL';
    if (error?.containmentEvidence) {
      summary.nativeExecutionCwd = error.containmentEvidence;
      summary.boundaries.mutationContainmentIndependentlyObserved = error.containmentEvidence.mutationContainmentIndependentlyObserved === true;
    }
    if (error?.providerNativeFailureEvidence) {
      summary.nativeFailure = normalizeProviderNativeFailureEvidence(error.providerNativeFailureEvidence);
      summary.boundaries.providerAuthorityExplicitlyBound = summary.nativeFailure.providerAuthorityExplicitlyBound;
    }
    summary.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error).split(/\r?\n/, 1)[0] };
    summary.completedAt = new Date().toISOString();
  }
  await writeFile(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(runRoot, 'report.md'), reportFor(summary), { flag: 'wx' });
  if (summary.outcome !== 'PASS') throw new Error(`Private-root Node-API integration failed; retained evidence: ${runRoot}`);
  return summary;
}

function usage() {
  return 'usage: node scripts/qa-private-root-node-api-integration.mjs --run-root <new direct child of test-results> --node-api-root <audited node-gyp version root> [--mode provider|rename-diagnostics|replacement-identity-diagnostics]';
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      if (!options.run_root || !options.node_api_root) throw new Error(usage());
      const summary = await runPrivateRootNodeApiIntegration({ runRoot: options.run_root, nodeApiRoot: options.node_api_root, mode: options.mode });
      console.log(JSON.stringify({ outcome: summary.outcome, runRoot: summary.runRoot, addon: summary.addon }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export { assertDirectChild, nodeApiInputs, parseArguments };
