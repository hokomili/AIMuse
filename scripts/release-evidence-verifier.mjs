import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { verifyPackageSubject } from './package-subject-verifier.mjs';
import { inspectProtectedRunRoot } from './release-protected-root-verifier.mjs';

const CONTROL_PATHS = [
  'scripts/initial-snapshot-manifest.json',
  'scripts/formal-package-workflow.mjs',
  'scripts/package-subject.mjs',
  'scripts/package-subject-verifier.mjs',
  'scripts/release-evidence-verifier.mjs',
  'scripts/release-protected-root-verifier.mjs',
  'scripts/verify-package.mjs',
];
const BASE_STAGES = [
  ['capture-source-inputs', 'internal-observation'],
  ['verify-source', 'command-observation', { type: 'npm', script: 'verify' }],
  ['native-test', 'command-observation', { type: 'npm', script: 'native:test' }],
  ['package-preflight', 'command-observation', { type: 'npm', script: 'prepackage' }],
  ['package-artifact-once', 'command-observation', { type: 'npm', script: 'package:artifact' }],
  ['confirm-source-inputs', 'internal-observation'],
  ['create-subject-manifest', 'internal-observation'],
  ['verify-subject-before-verifier', 'internal-observation'],
  ['verify-package-from-subject', 'command-observation', { type: 'node', script: 'scripts/verify-package.mjs' }],
  ['verify-subject-after-verifier', 'internal-observation'],
];
const LEVEL_2_STAGES = [
  ['verify-subject-at-e2e-handoff', 'internal-observation'],
  ['packaged-e2e-from-subject', 'command-observation', { type: 'npm', script: 'test:e2e:only' }],
  ['verify-subject-after-e2e', 'internal-observation'],
];

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function relativeEvidencePath(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split(/[\\/]/u).includes('..')) throw new Error(`Invalid formal evidence path: ${String(value)}`);
  const path = resolve(root, value);
  if (!strictChild(root, path)) throw new Error(`Formal evidence path escaped its protected root: ${value}`);
  return path;
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
function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[A-F\d]{64}$/iu.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value.toUpperCase();
}
function commandMatches(actual, expected) {
  if (!Array.isArray(actual) || !basename(actual[0] ?? '').toLocaleLowerCase('en-US').startsWith('node')) return false;
  if (expected.type === 'node') return actual.length === 2 && actual[1] === expected.script;
  return actual.length === 4 && basename(actual[1]).toLocaleLowerCase('en-US') === 'npm-cli.js' && actual[2] === 'run' && actual[3] === expected.script;
}
function forbiddenJudgementKeys(value, path = '$') {
  const failures = [];
  if (Array.isArray(value)) {
    value.forEach((child, index) => failures.push(...forbiddenJudgementKeys(child, `${path}[${index}]`)));
    return failures;
  }
  if (!value || typeof value !== 'object') return failures;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/^(?:verdict|pass|passed|result|status)$/iu.test(key)) failures.push(childPath);
    failures.push(...forbiddenJudgementKeys(child, childPath));
  }
  return failures;
}

async function assertOwnerPrivateFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${label} is not owned by the verifier user.`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible.`);
  }
  return info;
}
async function assertProtectedRoot(workspace, formalRunRoot, recorded) {
  const inspected = await inspectProtectedRunRoot({ workspace, formalRunRoot });
  const root = inspected.root;
  const canonicalPath = inspected.identity.canonicalPath;
  const expectedPath = relative(workspace, root).split(sep).join('/');
  if (recorded?.path !== expectedPath || recorded?.identity?.canonicalPath !== canonicalPath || recorded?.identity?.device !== inspected.identity.device || recorded?.identity?.inode !== inspected.identity.inode) {
    throw new Error('The formal run-root path or filesystem identity drifted from the observation manifest.');
  }
  return { root, canonicalPath, device: inspected.identity.device, inode: inspected.identity.inode };
}

async function verifyLog(workspace, root, declaration) {
  if (!declaration || typeof declaration !== 'object') throw new Error('A command observation is missing a log declaration.');
  const path = relativeEvidencePath(root, declaration.path);
  await inspectProtectedRunRoot({ workspace, formalRunRoot: root, paths: [path] });
  const info = await assertOwnerPrivateFile(path, `Observation log ${declaration.path}`);
  const bytes = await readFile(path);
  if (info.size !== declaration.bytes || sha256Bytes(bytes) !== assertSha256(declaration.sha256, `Observation log ${declaration.path}`)) throw new Error(`Observation log bytes drifted: ${declaration.path}`);
  return { path, bytes };
}

function expectedStages(level) {
  if (level !== 1 && level !== 2) throw new Error('Observation level must be 1 or 2.');
  return [...BASE_STAGES, ...(level === 2 ? LEVEL_2_STAGES : [])];
}

export async function verifyReleaseEvidence({ workspace = process.cwd(), formalRunRoot, observationManifestPath, expectedObservationManifestSha256, expectedVerifierSha256 } = {}, dependencies = {}) {
  const root = resolve(workspace);
  const runRoot = resolve(formalRunRoot ?? '');
  const observationPath = resolve(observationManifestPath ?? '');
  if (!formalRunRoot || !observationManifestPath) throw new Error('A formal run root and observation manifest are required.');
  if (!strictChild(runRoot, observationPath)) throw new Error('The observation manifest must be a strict child of the declared formal run root.');
  await assertOwnerPrivateFile(observationPath, 'Automation observation manifest');
  const observationBytes = await readFile(observationPath);
  const observationSha256 = sha256Bytes(observationBytes);
  if (observationSha256 !== assertSha256(expectedObservationManifestSha256, 'Expected observation manifest digest')) throw new Error('Automation observation manifest bytes drifted.');
  const verifierPath = fileURLToPath(import.meta.url);
  const verifierSha256 = await sha256File(verifierPath);
  if (verifierSha256 !== assertSha256(expectedVerifierSha256, 'Expected independent verifier digest')) throw new Error('The independently selected verifier bytes do not match the caller-controlled digest.');
  const observations = JSON.parse(observationBytes.toString('utf8'));
  if (observations?.schemaVersion !== 1 || observations.kind !== 'aimuse-formal-release-observations') throw new Error('Automation observation manifest schema is unsupported.');
  if (observations.acceptanceVerdict !== null) throw new Error('The evidence producer stored its own acceptance verdict.');
  const judgementKeys = forbiddenJudgementKeys(Object.fromEntries(Object.entries(observations).filter(([key]) => key !== 'acceptanceVerdict')));
  if (judgementKeys.length) throw new Error(`The evidence producer stored forbidden judgement fields: ${judgementKeys.join(', ')}`);
  const protectedRoot = await assertProtectedRoot(root, runRoot, observations.protectedRunRoot);
  const runLeaseArtifact = await verifyLog(root, runRoot, observations.runLease);
  const runLease = JSON.parse(runLeaseArtifact.bytes.toString('utf8'));
  if (runLease?.schemaVersion !== 1 || runLease.kind !== 'aimuse-formal-run-lease' || JSON.stringify(runLease.protectedRunRootIdentity) !== JSON.stringify(observations.protectedRunRoot.identity)) {
    throw new Error('The exclusive run lease does not bind the observed protected-root identity.');
  }
  const serialized = observationBytes.toString('utf8');
  if (/autonomous-output\/aimuse-corrected|\/private\/tmp\/aimuse-correction/iu.test(serialized)) throw new Error('Observation evidence depends on excluded historical candidate material.');
  if (observations.sourceInputs?.rootWasEnumerated !== false || observations.sourceInputs?.protectedRootsAccessed !== false || observations.sourceInputs?.scope !== 'manifest-authorized-clean-commit') {
    throw new Error('Observation evidence does not retain the manifest-only source boundary.');
  }

  const requiredControls = Object.fromEntries(await Promise.all(CONTROL_PATHS.map(async (path) => [path, await sha256File(resolve(root, path))])));
  if (JSON.stringify(Object.keys(observations.controls ?? {}).sort()) !== JSON.stringify([...CONTROL_PATHS].sort())) throw new Error('Observation evidence does not bind the complete verifier control set.');
  for (const path of CONTROL_PATHS) {
    if (assertSha256(observations.controls[path], `Control ${path}`) !== requiredControls[path]) throw new Error(`Verifier control drifted: ${path}`);
  }

  const expected = expectedStages(observations.level);
  if (!Array.isArray(observations.stages) || observations.stages.length !== expected.length) throw new Error('Observation evidence does not contain the exact required stage set.');
  for (let index = 0; index < expected.length; index += 1) {
    const [id, kind, command] = expected[index];
    const actual = observations.stages[index];
    if (actual?.id !== id || actual?.kind !== kind || actual?.exitCode !== 0) throw new Error(`Required stage ${id} was not observed with exit code zero in order.`);
    if (kind === 'internal-observation') {
      if ('command' in actual || 'stdout' in actual || 'stderr' in actual || 'signal' in actual) throw new Error(`Internal stage ${id} contains an invalid command observation.`);
      continue;
    }
    if (actual.signal !== null || !commandMatches(actual.command, command)) throw new Error(`Required command for stage ${id} was weakened or changed.`);
    await verifyLog(root, runRoot, actual.stdout);
    await verifyLog(root, runRoot, actual.stderr);
  }

  const packageManifestPath = relativeEvidencePath(runRoot, observations.packageSubject?.manifestPath);
  const packageResult = await (dependencies.verifyPackageSubject ?? verifyPackageSubject)({
    workspace: root,
    manifestPath: packageManifestPath,
    expectedManifestSha256: observations.packageSubject?.manifestSha256,
    formalRunRoot: runRoot,
    platform: process.platform,
  });
  const requiredPackageAssertions = [
    'requiredRuntimeEntries', 'minimumComponentSizes', 'exactMcpToolSurface',
    'providerFreeProductBoundary', 'rendererAuthorityIsolation',
    ...(process.platform === 'darwin' ? ['macosBundleContract', 'repoOwnedIcon', 'deepStrictSignature'] : []),
  ];
  for (const assertion of requiredPackageAssertions) if (packageResult.assertions?.[assertion] !== true) throw new Error(`Independent package assertion was not earned: ${assertion}`);
  if (/autonomous-output\/aimuse-corrected|\/private\/tmp\/aimuse-correction/iu.test(JSON.stringify(packageResult.manifest))) throw new Error('Package subject depends on excluded historical candidate material.');
  const packageDirectory = resolve(root, packageResult.manifest.subject.packageDirectory);
  if (!strictChild(runRoot, packageDirectory)) throw new Error('The formal package subject was not created inside its protected fresh run root.');
  if (packageResult.manifest.subject.identitySha256 !== observations.packageSubject?.subjectIdentitySha256) throw new Error('Package subject identity drifted from the observation manifest.');
  if (JSON.stringify(packageResult.manifest.inputs) !== JSON.stringify(observations.sourceInputs)) throw new Error('Observation and package manifests do not bind the same fresh source inputs.');

  const checks = [
    'caller-controlled-verifier-bytes',
    'producer-has-no-acceptance-verdict',
    'protected-run-root-identity',
    'manifest-authorized-clean-source',
    'complete-fresh-stage-observations',
    'observation-log-byte-bindings',
    'independent-package-byte-verification',
    'package-platform-signature-fuse-and-runtime-contract',
    'historical-evidence-excluded',
  ].map((id) => ({ id, satisfied: true }));
  return {
    schemaVersion: 1,
    reportKind: 'independently-derived-release-evidence-verification',
    verdict: 'PASS',
    verifierSha256,
    observationManifestSha256: observationSha256,
    source: {
      commit: packageResult.manifest.inputs.gitHead,
      tree: packageResult.manifest.inputs.gitTree,
      manifestSha256: packageResult.manifest.inputs.sourceManifestSha256,
      entries: packageResult.manifest.inputs.workspaceInputFiles,
      entriesSha256: packageResult.manifest.inputs.workspaceInputsSha256,
    },
    package: {
      subjectIdentitySha256: packageResult.manifest.subject.identitySha256,
      executableSha256: packageResult.manifest.subject.files.applicationExecutable.sha256,
      applicationAsarSha256: packageResult.manifest.subject.files.applicationAsar.sha256,
      signature: packageResult.manifest.subject.signature.kind,
      architecture: packageResult.manifest.subject.architecture,
    },
    protectedRunRoot: protectedRoot,
    checks,
    limitations: [
      'Automated release evidence does not replace independent Computer Use review or hardware audio/MIDI/plugin validation.',
      'An ad-hoc signature does not earn Developer ID, Gatekeeper, notarization, stapling, updater, or distribution claims.',
      'Level 2 automation alone does not satisfy Level 3 or stable-release acceptance.',
    ],
  };
}

async function main() {
  const values = parseCli(process.argv.slice(2));
  const report = await verifyReleaseEvidence({
    workspace: values.get('workspace') || process.cwd(),
    formalRunRoot: required(values, 'formal-run-root'),
    observationManifestPath: required(values, 'observations'),
    expectedObservationManifestSha256: required(values, 'expected-observations-sha256'),
    expectedVerifierSha256: required(values, 'expected-verifier-sha256'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse independent release evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
