import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { atomicWriteJsonEvidence } from './qa-evidence.mjs';
import { assertOwnerPrivateRoot, normalizePrivateRootIdentity, protectOwnerPrivateRoot } from './qa-private-root.mjs';

const HELP = `AIMuse default Windows private-root integration

Usage:
  node scripts/qa-private-root-windows-integration.mjs --run-root <new direct child of test-results>

The run root must be an absolute, verified-absent direct child of test-results.
On Windows, run this as one whole command under the same unsandboxed user that
would launch AIMuse. The harness starts no application and accesses no bearer.
It retains credential-free PASS evidence; on failure it removes only the exact
run root after confirming that the directory object has not changed.
`;

function samePath(left, right, platform = process.platform) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return platform === 'win32'
    ? leftPath.toUpperCase() === rightPath.toUpperCase()
    : leftPath === rightPath;
}

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function objectIdentity(info, canonicalPath) {
  if (!info?.isDirectory?.() || info.isSymbolicLink?.()) throw new Error('Integration run root must remain a real directory.');
  const device = String(info.dev);
  const inode = String(info.ino);
  if (!/^\d+$/.test(device) || !/^\d+$/.test(inode)) throw new Error('Integration run root does not expose a stable filesystem identity.');
  return { canonicalPath: resolve(canonicalPath), device, inode };
}

async function pathExists(path, lstatPath = lstat) {
  try {
    await lstatPath(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') {
      values.set('help', true);
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : arguments_[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    if (values.has(key)) throw new Error(`--${key} may be supplied only once.`);
    values.set(key, value);
  }
  return values;
}

export function validateIntegrationRunRoot(runRootValue, testResultsRoot = resolve('test-results'), platform = process.platform) {
  if (typeof runRootValue !== 'string' || !isAbsolute(runRootValue)) throw new Error('--run-root must be an absolute path.');
  const root = resolve(runRootValue);
  const allowedParent = resolve(testResultsRoot);
  if (!samePath(dirname(root), allowedParent, platform)) throw new Error(`--run-root must be one direct child below ${allowedParent}.`);
  return root;
}

export function assertStablePrivateRootObservations(values, expectedRoot, platform = process.platform) {
  if (!Array.isArray(values) || values.length < 3) throw new Error('At least three private-root identity observations are required.');
  let expected;
  for (const [index, rawValue] of values.entries()) {
    const value = asRecord(rawValue, `Private-root observation ${index + 1}`);
    if (value.platform !== 'win32' || value.owner !== 'launching-user') throw new Error(`Private-root observation ${index + 1} did not use the default Windows owner contract.`);
    if (!samePath(value.root, expectedRoot, platform)) throw new Error(`Private-root observation ${index + 1} reported the wrong root.`);
    if (JSON.stringify(value.allowedPrincipals) !== JSON.stringify(['launching-user', 'SYSTEM', 'Administrators'])) throw new Error(`Private-root observation ${index + 1} reported the wrong allowed principals.`);
    const identity = normalizePrivateRootIdentity(value.identity, `Private-root observation ${index + 1} identity`);
    if (!samePath(identity.canonicalPath, expectedRoot, platform)) throw new Error(`Private-root observation ${index + 1} reported the wrong canonical path.`);
    if (!expected) expected = identity;
    else if (!samePath(identity.canonicalPath, expected.canonicalPath, platform) || identity.device !== expected.device || identity.inode !== expected.inode) throw new Error('Private-root canonical/device/inode identity changed between observations.');
  }
  return expected;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function removeFailedRunRoot(root, createdIdentity, dependencies) {
  const lstatPath = dependencies.lstatPath ?? lstat;
  const realpathPath = dependencies.realpathPath ?? realpath;
  const removePath = dependencies.removePath ?? rm;
  if (!await pathExists(root, lstatPath)) return { removed: false, alreadyAbsent: true };
  const liveIdentity = objectIdentity(await lstatPath(root), await realpathPath(root));
  if (!samePath(liveIdentity.canonicalPath, createdIdentity.canonicalPath, dependencies.platform) || liveIdentity.device !== createdIdentity.device || liveIdentity.inode !== createdIdentity.inode) throw new Error('Refusing cleanup because the integration run-root directory object changed.');
  await removePath(root, { recursive: true, force: false });
  if (await pathExists(root, lstatPath)) throw new Error('Integration run-root cleanup did not remove the exact fixture root.');
  return { removed: true, alreadyAbsent: false };
}

function reportFor(summary) {
  return `# AIMuse QA-10 default Windows private-root integration

## Outcome

- **PASS** for the default, non-injected Windows private-root verifier.
- This is a launch-free ACL/filesystem integration check, not package or Luna/high certification.

## Evidence

- Fresh disposable run root: \`${summary.runRoot}\`.
- Protected subject: \`${summary.protectedRoot.path}\`; accepted ${summary.protectedRoot.identityObservations} times with stable canonical path, device and inode.
- Real Windows DACL inspection allowed only the launching user, SYSTEM and Administrators, with inheritance protected and owner FullControl.
- Inherited sibling: \`${summary.inheritedBroadSibling.path}\`; rejected by the default verifier because it retained inherited access rules.
- No application, process lifecycle, connection bearer, credential, provider, browser, network or retained run was accessed.

## Cleanup contract

- PASS evidence is retained only under the exact run root for audit.
- A failed run removes only that exact root after rechecking its canonical/device/inode identity. Later disposal must use the same exact root and first revalidate the identity recorded in \`summary.json\`.
`;
}

export async function runPrivateRootWindowsIntegration(runRootValue, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('The default private-root integration requires Windows.');
  const testResultsRoot = resolve(dependencies.testResultsRoot ?? 'test-results');
  const runRoot = validateIntegrationRunRoot(runRootValue, testResultsRoot, platform);
  const lstatPath = dependencies.lstatPath ?? lstat;
  const realpathPath = dependencies.realpathPath ?? realpath;
  const mkdirPath = dependencies.mkdirPath ?? mkdir;
  const protectRoot = dependencies.protectRoot ?? protectOwnerPrivateRoot;
  const verifyRoot = dependencies.verifyRoot ?? assertOwnerPrivateRoot;
  const writeJson = dependencies.writeJson ?? atomicWriteJsonEvidence;
  const writeText = dependencies.writeText ?? writeFile;
  const readBytes = dependencies.readBytes ?? readFile;
  let createdIdentity;
  let completed = false;
  let result;
  let failure;

  try {
    const testResultsInfo = await lstatPath(testResultsRoot);
    if (!testResultsInfo.isDirectory() || testResultsInfo.isSymbolicLink()) throw new Error('test-results must be a real directory.');
    const canonicalTestResults = await realpathPath(testResultsRoot);
    if (!samePath(canonicalTestResults, testResultsRoot, platform)) throw new Error('test-results must not resolve through a different canonical path.');
    if (await pathExists(runRoot, lstatPath)) throw new Error(`Private-root integration path already exists: ${runRoot}.`);

    await mkdirPath(runRoot, { recursive: false });
    createdIdentity = objectIdentity(await lstatPath(runRoot), await realpathPath(runRoot));
    if (!samePath(createdIdentity.canonicalPath, runRoot, platform)) throw new Error('Fresh integration root resolved to an unexpected canonical path.');

    const protectedRoot = join(runRoot, 'protected-root');
    const inheritedBroadSibling = join(runRoot, 'inherited-broad-sibling');
    await mkdirPath(protectedRoot, { recursive: false });
    await mkdirPath(inheritedBroadSibling, { recursive: false });
    const protectedAcl = await protectRoot(protectedRoot);
    if (protectedAcl?.platform !== 'win32' || protectedAcl?.owner !== 'launching-user' || JSON.stringify(protectedAcl?.allowedPrincipals) !== JSON.stringify(['launching-user', 'SYSTEM', 'Administrators'])) throw new Error('Root protection did not establish the declared Windows principal contract.');

    const observations = [];
    observations.push(await verifyRoot({ privateRoot: protectedRoot, paths: [protectedRoot], evidenceRoot: runRoot }));
    observations.push(await verifyRoot({ privateRoot: protectedRoot, paths: [protectedRoot], evidenceRoot: runRoot }));

    let broadRejection;
    try {
      await verifyRoot({ privateRoot: inheritedBroadSibling, paths: [inheritedBroadSibling], evidenceRoot: runRoot });
    } catch (error) {
      broadRejection = error;
    }
    if (!broadRejection) throw new Error('Default verifier accepted the inherited-broad sibling.');
    if (!String(broadRejection.message).includes('still inherits access rules')) throw new Error(`Inherited-broad sibling failed for an unexpected reason: ${broadRejection.message}`);

    observations.push(await verifyRoot({ privateRoot: protectedRoot, paths: [protectedRoot], evidenceRoot: runRoot }));
    const stableIdentity = assertStablePrivateRootObservations(observations, protectedRoot, platform);
    const summary = {
      version: 1,
      outcome: 'PASS',
      scope: 'QA-10 default Windows private-root verifier integration',
      runRoot,
      runRootIdentity: { version: 1, ...createdIdentity },
      protectedRoot: {
        path: protectedRoot,
        accepted: true,
        identityObservations: observations.length,
        identity: stableIdentity,
        owner: 'launching-user',
        allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
        inheritedFromBroadParent: false,
      },
      inheritedBroadSibling: {
        path: inheritedBroadSibling,
        rejected: true,
        reason: 'Private run root still inherits access rules.',
      },
      boundaries: {
        defaultVerifier: true,
        applicationLaunched: false,
        processInspectedOrSignaled: false,
        credentialOrBearerAccessed: false,
        networkUsed: false,
        retainedRootAccessed: false,
      },
      cleanup: {
        failureScope: runRoot,
        failureRequiresMatchingDirectoryIdentity: true,
        passEvidenceRetained: true,
      },
    };
    const summaryPath = join(runRoot, 'summary.json');
    const reportPath = join(runRoot, 'report.md');
    await writeJson(summaryPath, summary, { validate: (value) => {
      if (value?.outcome !== 'PASS' || value?.protectedRoot?.identityObservations !== 3 || value?.inheritedBroadSibling?.rejected !== true) throw new Error('Invalid Windows private-root integration summary.');
    } });
    await writeText(reportPath, reportFor(summary), { encoding: 'utf8' });
    const persisted = JSON.parse(await readBytes(summaryPath, 'utf8'));
    if (JSON.stringify(persisted) !== JSON.stringify(summary)) throw new Error('Persisted integration summary did not round-trip exactly.');
    result = {
      ...summary,
      artifacts: {
        summary: { path: summaryPath, sha256: await sha256(summaryPath) },
        report: { path: reportPath, sha256: await sha256(reportPath) },
      },
    };
    completed = true;
  } catch (error) {
    failure = error;
  }

  if (!completed && createdIdentity) {
    try {
      await removeFailedRunRoot(runRoot, createdIdentity, { ...dependencies, platform });
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'Windows private-root integration failed and exact-root cleanup also failed.');
    }
  }
  if (failure) throw failure;
  return result;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  if (values.has('help')) {
    process.stdout.write(HELP);
    return;
  }
  const runRoot = values.get('run-root');
  if (!runRoot) throw new Error('--run-root is required.');
  const result = await runPrivateRootWindowsIntegration(runRoot);
  process.stdout.write(`${JSON.stringify({
    outcome: result.outcome,
    runRoot: result.runRoot,
    protectedRoot: result.protectedRoot,
    inheritedBroadSibling: result.inheritedBroadSibling,
    artifacts: result.artifacts,
    cleanup: result.cleanup,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
