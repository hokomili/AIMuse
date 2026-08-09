import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

const REDACTED_CONNECTION_FIELDS = new Set([
  'version',
  'url',
  'activeProjectId',
  'pid',
  'instanceId',
  'profileId',
  'trustedFolders',
  'stoppedAt',
  'credentialsRedacted',
]);
const FAULT_STAGES = new Set(['after-partial-write', 'before-rename']);

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export function buildRedactedConnection(manifestValue, connectionValue = {}, stoppedAt = new Date().toISOString()) {
  const manifest = asRecord(manifestValue, 'QA session manifest');
  const connection = asRecord(connectionValue, 'QA session connection');
  const redacted = {
    version: 1,
    url: manifest.mcpUrl,
    activeProjectId: typeof connection.activeProjectId === 'string' ? connection.activeProjectId : undefined,
    pid: manifest.pid,
    instanceId: manifest.instanceId,
    profileId: manifest.profileId,
    trustedFolders: Array.isArray(manifest.trustedFolders) ? manifest.trustedFolders.filter((folder) => typeof folder === 'string') : [],
    stoppedAt,
    credentialsRedacted: true,
  };
  validateRedactedConnection(redacted, manifest);
  return redacted;
}

export function validateRedactedConnection(value, manifestValue) {
  const connection = asRecord(value, 'Redacted QA session connection');
  const manifest = asRecord(manifestValue, 'QA session manifest');
  for (const key of Object.keys(connection)) {
    if (!REDACTED_CONNECTION_FIELDS.has(key)) throw new Error(`Redacted QA session connection contains an untrusted field: ${key}.`);
  }
  if (connection.version !== 1 || connection.credentialsRedacted !== true) throw new Error('Invalid redacted QA session connection marker.');
  if (connection.url !== manifest.mcpUrl || Number(connection.pid) !== Number(manifest.pid)) throw new Error('Redacted QA session connection identity mismatch.');
  if (connection.instanceId !== manifest.instanceId) throw new Error('Redacted QA session connection instance mismatch.');
  if (connection.profileId !== manifest.profileId) throw new Error('Redacted QA session connection profile mismatch.');
  if (connection.activeProjectId !== undefined && typeof connection.activeProjectId !== 'string') throw new Error('Invalid redacted QA session active project ID.');
  if (!Array.isArray(connection.trustedFolders) || connection.trustedFolders.some((folder) => typeof folder !== 'string')) throw new Error('Invalid redacted QA session trusted folders.');
  const expectedFolders = Array.isArray(manifest.trustedFolders) ? manifest.trustedFolders.filter((folder) => typeof folder === 'string') : [];
  if (JSON.stringify(connection.trustedFolders) !== JSON.stringify(expectedFolders)) throw new Error('Redacted QA session trusted folders mismatch.');
  if (typeof connection.stoppedAt !== 'string' || !Number.isFinite(Date.parse(connection.stoppedAt))) throw new Error('Invalid redacted QA session stop time.');
  return connection;
}

export async function atomicWriteJsonEvidence(path, value, options = {}) {
  const { beforeRename, faultAt, validate } = options;
  if (faultAt !== undefined && !FAULT_STAGES.has(faultAt)) throw new Error(`Unknown atomic evidence fault stage: ${faultAt}.`);
  if (beforeRename !== undefined && typeof beforeRename !== 'function') throw new Error('beforeRename must be a function.');
  if (validate !== undefined && typeof validate !== 'function') throw new Error('validate must be a function.');

  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(dirname(path), { recursive: true });

  let committed = false;
  let temporaryCreated = false;
  let handle;
  let operationError;
  let stagedValue;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    if (faultAt === 'after-partial-write') {
      const partialLength = Math.max(1, Math.floor(bytes.length / 2));
      await handle.writeFile(bytes.subarray(0, partialLength));
      await handle.sync();
      throw new Error('Injected atomic evidence failure after a partial write.');
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const stagedText = await readFile(temporaryPath, 'utf8');
    if (stagedText !== text) throw new Error(`Atomic evidence staging verification failed for ${path}.`);
    stagedValue = JSON.parse(stagedText);
    if (validate) validate(stagedValue);
    if (beforeRename) await beforeRename({ text: stagedText, value: stagedValue });
    if (faultAt === 'before-rename') throw new Error('Injected atomic evidence failure before rename.');
    await rename(temporaryPath, path);
    committed = true;
  } catch (error) {
    operationError = error;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (error) { operationError ??= error; }
    }
    if (temporaryCreated && !committed) {
      try { await rm(temporaryPath, { force: true }); } catch (error) {
        operationError = operationError
          ? new AggregateError([operationError, error], `Atomic evidence write and cleanup failed for ${path}.`)
          : error;
      }
    }
  }
  if (operationError) throw operationError;
  return stagedValue;
}
