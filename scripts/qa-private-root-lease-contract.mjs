import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import {
  assertOwnerPrivateRoot,
  assertPrivateRootDeclaration,
  normalizePrivateRootIdentity,
} from './qa-private-root.mjs';

export const PRIVATE_ROOT_LEASE_CAPABILITIES = Object.freeze([
  'rootHandleHeld',
  'rootDeleteShareDenied',
  'securityDescriptorByHandle',
  'finalPathByHandle',
  'fileIdentityByHandle',
  'reparseMetadataByHandle',
  'handleValidatedReadSnapshots',
  'pinnedAbsolutePathAtomicReplace',
]);

const DESCRIPTOR_KEYS = new Set(['version', 'root', 'identity', 'security', 'object', 'capabilities']);
const SECURITY_KEYS = new Set(['owner', 'protected', 'allowOnly', 'ownerFullControl', 'allowedPrincipals']);
const OBJECT_KEYS = new Set(['directory', 'reparsePoint', 'deleteShareDenied']);
const SNAPSHOT_KEYS = new Set(['version', 'path', 'rootIdentity', 'fileIdentity', 'contained', 'reparsePoint', 'securityValidated', 'bytes']);
const REPLACE_KEYS = new Set(['version', 'path', 'rootIdentity', 'committed', 'stagedAndRenamedByHandle', 'pinnedAbsoluteTarget', 'byteLength']);
const PRIVATE_KEYS = new Set(['apikey', 'authorization', 'password', 'secret', 'sessionid', 'token', 'tokenhint']);

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field: ${key}.`);
}

function samePath(left, right, platform = process.platform) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return platform === 'win32'
    ? leftPath.toUpperCase() === rightPath.toUpperCase()
    : leftPath === rightPath;
}

function within(root, path) {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function assertIdentity(expectedValue, actualValue, label, platform) {
  const expected = normalizePrivateRootIdentity(expectedValue, 'Expected private-root identity');
  const actual = normalizePrivateRootIdentity(actualValue, label);
  if (!samePath(expected.canonicalPath, actual.canonicalPath, platform) || expected.device !== actual.device || expected.inode !== actual.inode) throw new Error(`${label} does not match the persisted private-root identity.`);
  return actual;
}

function assertCredentialFreeObject(value, label, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase())) throw new Error(`${label} exposes a private field: ${key}.`);
    assertCredentialFreeObject(entry, label, seen);
  }
}

export function normalizePrivateRootLeaseDescriptor(value, expectedRoot, expectedIdentity, platform = process.platform) {
  const descriptor = asRecord(value, 'Private-root lease descriptor');
  assertExactKeys(descriptor, DESCRIPTOR_KEYS, 'Private-root lease descriptor');
  if (descriptor.version !== 1 || typeof descriptor.root !== 'string' || !isAbsolute(descriptor.root) || !samePath(descriptor.root, expectedRoot, platform)) throw new Error('Private-root lease descriptor identifies the wrong root.');
  const identity = assertIdentity(expectedIdentity, descriptor.identity, 'Private-root lease identity', platform);

  const security = asRecord(descriptor.security, 'Private-root handle security');
  assertExactKeys(security, SECURITY_KEYS, 'Private-root handle security');
  if (security.owner !== 'launching-user' || security.protected !== true || security.allowOnly !== true || security.ownerFullControl !== true) throw new Error('Private-root handle security does not preserve the owner-private ACL contract.');
  if (JSON.stringify(security.allowedPrincipals) !== JSON.stringify(['launching-user', 'SYSTEM', 'Administrators'])) throw new Error('Private-root handle security reports the wrong allowed principals.');

  const object = asRecord(descriptor.object, 'Private-root handle object');
  assertExactKeys(object, OBJECT_KEYS, 'Private-root handle object');
  if (object.directory !== true || object.reparsePoint !== false || object.deleteShareDenied !== true) throw new Error('Private-root handle does not pin one non-reparse directory against delete/rename replacement.');

  const capabilities = asRecord(descriptor.capabilities, 'Private-root lease capabilities');
  assertExactKeys(capabilities, new Set(PRIVATE_ROOT_LEASE_CAPABILITIES), 'Private-root lease capabilities');
  for (const capability of PRIVATE_ROOT_LEASE_CAPABILITIES) if (capabilities[capability] !== true) throw new Error(`Private-root lease is missing required capability: ${capability}.`);
  assertCredentialFreeObject(descriptor, 'Private-root lease descriptor');
  return { version: 1, root: resolve(descriptor.root), identity, security: structuredClone(security), object: structuredClone(object), capabilities: structuredClone(capabilities) };
}

function normalizeSnapshot(value, expectedPath, expectedRootIdentity, platform) {
  const snapshot = asRecord(value, 'Handle-validated read snapshot');
  assertExactKeys(snapshot, SNAPSHOT_KEYS, 'Handle-validated read snapshot');
  if (snapshot.version !== 1 || typeof snapshot.path !== 'string' || !isAbsolute(snapshot.path) || !samePath(snapshot.path, expectedPath, platform)) throw new Error('Handle-validated read snapshot identifies the wrong path.');
  assertIdentity(expectedRootIdentity, snapshot.rootIdentity, 'Read snapshot root identity', platform);
  const fileIdentity = normalizePrivateRootIdentity(snapshot.fileIdentity, 'Read snapshot file identity');
  if (!samePath(fileIdentity.canonicalPath, expectedPath, platform) || snapshot.contained !== true || snapshot.reparsePoint !== false || snapshot.securityValidated !== true) throw new Error('Handle-validated read snapshot is not one contained, non-reparse, security-validated file.');
  if (!(typeof snapshot.bytes === 'string' || snapshot.bytes instanceof Uint8Array)) throw new Error('Handle-validated read snapshot did not return bytes.');
  assertCredentialFreeObject({ version: snapshot.version, path: snapshot.path, rootIdentity: snapshot.rootIdentity, fileIdentity: snapshot.fileIdentity, contained: snapshot.contained, reparsePoint: snapshot.reparsePoint, securityValidated: snapshot.securityValidated }, 'Handle-validated read snapshot metadata');
  return snapshot.bytes;
}

function normalizeReplaceResult(value, expectedPath, expectedRootIdentity, byteLength, platform) {
  const result = asRecord(value, 'Pinned absolute-path atomic replace result');
  assertExactKeys(result, REPLACE_KEYS, 'Pinned absolute-path atomic replace result');
  if (result.version !== 1 || typeof result.path !== 'string' || !isAbsolute(result.path) || !samePath(result.path, expectedPath, platform)) throw new Error('Pinned absolute-path atomic replace identifies the wrong path.');
  assertIdentity(expectedRootIdentity, result.rootIdentity, 'Atomic replace root identity', platform);
  if (result.committed !== true || result.stagedAndRenamedByHandle !== true || result.pinnedAbsoluteTarget !== true || result.byteLength !== byteLength) throw new Error('Pinned absolute-path atomic replace did not commit the exact supplied bytes.');
  assertCredentialFreeObject(result, 'Pinned absolute-path atomic replace result');
  return structuredClone(result);
}

function requiredLeaseMethod(lease, name) {
  if (typeof lease?.[name] !== 'function') throw new Error(`Private-root lease provider is missing ${name}().`);
  return lease[name].bind(lease);
}

export async function withPrivateRootHandleLease(options, operation, dependencies = {}) {
  if (typeof operation !== 'function') throw new Error('Private-root lease operation must be a function.');
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('The private-root handle lease contract currently targets Windows only.');
  const privateRoot = resolve(options?.privateRoot ?? '');
  const paths = Array.isArray(options?.paths) ? options.paths.map((path) => resolve(path)) : [];
  if (!isAbsolute(options?.privateRoot ?? '') || !paths.length) throw new Error('Private-root handle lease requires an absolute root and at least one protected path.');
  for (const path of paths) if (!within(privateRoot, path)) throw new Error(`Private-root lease path escapes its root: ${path}.`);
  const persistedRoot = options?.persistedRoot;
  const persistedIdentity = options?.persistedIdentity;
  const assertPrivateRoot = dependencies.assertPrivateRoot ?? assertOwnerPrivateRoot;
  const observe = async () => {
    const observed = await assertPrivateRoot({ privateRoot, paths });
    assertPrivateRootDeclaration(privateRoot, persistedRoot, persistedIdentity, observed, platform);
    return observed;
  };

  const initial = await observe();
  const expectedIdentity = assertPrivateRootDeclaration(privateRoot, persistedRoot, persistedIdentity, initial, platform);
  if (typeof dependencies.acquireLease !== 'function') throw new Error('Architecture review required: no approved Windows handle-bound private-root provider is installed.');

  let lease;
  let result;
  let operationError;
  let closeError;
  try {
    lease = await dependencies.acquireLease({ version: 1, privateRoot, paths: [...paths], expectedIdentity });
    const closeLease = requiredLeaseMethod(lease, 'close');
    const assertCurrent = requiredLeaseMethod(lease, 'assertCurrent');
    const readSnapshot = requiredLeaseMethod(lease, 'readSnapshot');
    const atomicReplace = requiredLeaseMethod(lease, 'atomicReplace');
    const descriptor = normalizePrivateRootLeaseDescriptor(lease.descriptor, privateRoot, expectedIdentity, platform);
    let stickyFailure;
    const sticky = async (work) => {
      if (stickyFailure) throw stickyFailure;
      try { return await work(); }
      catch (error) { stickyFailure = error; throw error; }
    };
    const guard = () => sticky(async () => {
      normalizePrivateRootLeaseDescriptor(await assertCurrent(), privateRoot, expectedIdentity, platform);
      await observe();
      normalizePrivateRootLeaseDescriptor(await assertCurrent(), privateRoot, expectedIdentity, platform);
      return descriptor;
    });
    const exactPath = (pathValue) => {
      const path = resolve(pathValue);
      if (!paths.some((allowed) => samePath(allowed, path, platform))) throw new Error(`Private-root lease operation is not allowlisted for path: ${path}.`);
      return path;
    };

    await guard();
    const context = Object.freeze({
      descriptor,
      guard,
      runSensitive: async (label, action) => {
        if (typeof label !== 'string' || !label.trim() || typeof action !== 'function') throw new Error('Handle-bound sensitive action requires a label and function.');
        await guard();
        const value = await action();
        await guard();
        return value;
      },
      readSnapshot: async (pathValue) => {
        const path = exactPath(pathValue);
        await guard();
        const bytes = await sticky(async () => normalizeSnapshot(await readSnapshot(path), path, expectedIdentity, platform));
        await guard();
        return bytes;
      },
      atomicReplace: async (pathValue, bytes) => {
        const path = exactPath(pathValue);
        if (!(typeof bytes === 'string' || bytes instanceof Uint8Array)) throw new Error('Pinned absolute-path atomic replace requires bytes.');
        const byteLength = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
        await guard();
        const value = await sticky(async () => normalizeReplaceResult(await atomicReplace(path, bytes), path, expectedIdentity, byteLength, platform));
        await guard();
        return value;
      },
    });
    result = await operation(context);
    await guard();
    lease = undefined;
    await closeLease();
  } catch (error) {
    operationError = error;
  } finally {
    if (lease) {
      try { await requiredLeaseMethod(lease, 'close')(); }
      catch (error) { closeError = error; }
    }
  }
  if (operationError && closeError) throw new AggregateError([operationError, closeError], 'Private-root handle lease operation and close both failed.');
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return result;
}
