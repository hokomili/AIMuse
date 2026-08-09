import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteJsonEvidence, buildRedactedConnection, validateRedactedConnection } from '../../scripts/qa-evidence.mjs';
import { assertOwnerPrivateRoot } from '../../scripts/qa-private-root.mjs';
import { show, status, stop } from '../../scripts/qa-session.mjs';

const createdRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(resolve('test-results', 'qa-evidence-'));
  createdRoots.push(root);
  return root;
}

async function temporaryFiles(root) {
  return (await readdir(root)).filter((name) => name.endsWith('.tmp'));
}

async function currentExecutableHash() {
  return createHash('sha256').update(await readFile(process.execPath)).digest('hex').toUpperCase();
}

async function runQaSession(command, manifest) {
  const privateRoot = dirname(manifest);
  let stdout = '';
  let exitCode = 0;
  const user = 'S-1-5-21-111-222-333-1001';
  const rules = [{ sid: user, type: 'Allow', rights: 'FullControl' }, { sid: 'S-1-5-18', type: 'Allow', rights: 'FullControl' }, { sid: 'S-1-5-32-544', type: 'Allow', rights: 'FullControl' }];
  const commands = { show, status, stop };
  try {
    await commands[command](new Map([['private-root', [privateRoot]], ['manifest', [manifest]]]), {
      platform: 'win32',
      assertPrivateRoot: (options) => assertOwnerPrivateRoot(options, { platform: 'win32', currentWindowsSid: async () => user, inspectWindowsAcl: async (path) => ({ protected: path === privateRoot, ownerSid: user, rules }) }),
      writeOutput: (text) => { stdout += text; },
      setExitCode: (code) => { exitCode = code; },
    });
    return { status: exitCode, stdout, stderr: '' };
  } catch (error) {
    return { status: 1, stdout, stderr: error instanceof Error ? error.message : String(error) };
  }
}

afterEach(async () => {
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('atomic QA coordination evidence', () => {
  it('preserves a known-good manifest and cleans the truncated stage after an interrupted partial write', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'session.json');
    const knownGood = '{"sentinel":"known-good-manifest"}\n';
    await writeFile(target, knownGood);

    await expect(atomicWriteJsonEvidence(target, { sentinel: 'replacement', identity: 'new' }, {
      faultAt: 'after-partial-write',
    })).rejects.toThrow('after a partial write');

    expect(await readFile(target, 'utf8')).toBe(knownGood);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('rejects malformed identity before replace and leaves the known-good connection untouched', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'connection.json');
    const knownGood = '{"sentinel":"known-good-connection"}\n';
    await writeFile(target, knownGood);

    await expect(atomicWriteJsonEvidence(target, { pid: 22, url: 'http://127.0.0.1:1/mcp' }, {
      validate: () => { throw new Error('injected connection identity rejection'); },
    })).rejects.toThrow('injected connection identity rejection');

    expect(await readFile(target, 'utf8')).toBe(knownGood);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('serializes colliding valid manifest writes as one complete document with no abandoned stages', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'session.json');
    const first = { version: 1, identity: 'first', padding: 'a'.repeat(4096) };
    const second = { version: 1, identity: 'second', padding: 'b'.repeat(2048) };

    await Promise.all([
      atomicWriteJsonEvidence(target, first, { validate: (value) => expect(['first', 'second']).toContain(value.identity) }),
      atomicWriteJsonEvidence(target, second, { validate: (value) => expect(['first', 'second']).toContain(value.identity) }),
    ]);

    const finalValue = JSON.parse(await readFile(target, 'utf8'));
    expect([first, second]).toContainEqual(finalValue);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('stages only allowlisted redaction data and preserves the credential-bearing source if commit fails', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'connection.json');
    const credential = 'fake-test-secret-never-stage';
    const knownGood = `${JSON.stringify({ token: credential, tokenHint: 'fake-hint', sessionId: 'fake-session' })}\n`;
    const manifest = { pid: 99_999_991, mcpUrl: 'http://127.0.0.1:48300/mcp', trustedFolders: [join(root, 'trusted')] };
    const redacted = buildRedactedConnection(manifest, { token: credential, activeProjectId: 'project_test' }, '2026-08-05T00:00:00.000Z');
    let stagedText = '';
    await writeFile(target, knownGood);

    await expect(atomicWriteJsonEvidence(target, redacted, {
      validate: (value) => validateRedactedConnection(value, manifest),
      beforeRename: ({ text }) => { stagedText = text; throw new Error('injected redaction commit failure'); },
    })).rejects.toThrow('injected redaction commit failure');

    expect(stagedText).not.toContain(credential);
    expect(stagedText).not.toContain('token');
    expect(stagedText).not.toContain('tokenHint');
    expect(stagedText).not.toContain('sessionId');
    expect(await readFile(target, 'utf8')).toBe(knownGood);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('keeps manifest and redacted connection identity coherent when the second-file commit is interrupted', async () => {
    const root = await temporaryRoot();
    const manifestPath = join(root, 'session.json');
    const connectionPath = join(root, 'connection.json');
    const profile = join(root, 'profile');
    const rootInfo = await lstat(root);
    const manifest = {
      version: 1,
      exe: process.execPath,
      exeSha256: await currentExecutableHash(),
      privateRoot: root,
      privateRootIdentity: { version: 1, canonicalPath: await realpath(root), device: String(rootInfo.dev), inode: String(rootInfo.ino) },
      profile,
      profileId: createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex').toUpperCase(),
      pid: 99_999_992,
      instanceId: '11111111-1111-4111-8111-111111111111',
      mcpUrl: 'http://127.0.0.1:48301/mcp',
      connection: connectionPath,
      mode: 'headless',
      connectionCredentialsRedacted: false,
      trustedFolders: [],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const redacted = buildRedactedConnection(manifest, { token: 'fake-test-token' }, '2026-08-05T00:00:00.000Z');
    await writeFile(manifestPath, manifestText);
    await writeFile(connectionPath, JSON.stringify({ pid: manifest.pid, url: manifest.mcpUrl, token: 'fake-test-token' }));

    await atomicWriteJsonEvidence(connectionPath, redacted, { validate: (value) => validateRedactedConnection(value, manifest) });
    await expect(atomicWriteJsonEvidence(manifestPath, { ...manifest, connectionCredentialsRedacted: true }, {
      faultAt: 'before-rename',
    })).rejects.toThrow('before rename');

    const retainedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const committedConnection = JSON.parse(await readFile(connectionPath, 'utf8'));
    expect(retainedManifest).toEqual(manifest);
    expect(committedConnection).toMatchObject({ pid: manifest.pid, instanceId: manifest.instanceId, profileId: manifest.profileId, url: manifest.mcpUrl, credentialsRedacted: true });
    expect(committedConnection).not.toHaveProperty('token');
    for (const command of ['status', 'show', 'stop']) {
      const result = await runQaSession(command, manifestPath);
      expect(result.status).not.toBe(0);
      if (command === 'status') {
        const status = JSON.parse(result.stdout);
        expect(status.processInspection).toBe('performed');
        expect(status.processAlive).toBe(false);
        expect(status.health).toEqual({ skipped: 'process not alive' });
      } else {
        expect(result.stderr).toContain(`QA PID ${manifest.pid} is not alive`);
      }
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
      expect(JSON.parse(await readFile(connectionPath, 'utf8'))).toEqual(committedConnection);
    }
    expect(await temporaryFiles(root)).toEqual([]);
  });
});
