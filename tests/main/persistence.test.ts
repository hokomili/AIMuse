import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, entityBase, HUMAN_ACTOR, type MediaAsset } from '@aimuse/core';
import { atomicWriteFile, packProjectFolder, readProjectFolder, saveProjectFolder, unpackProjectPack } from '../../src/main/persistence';

describe('project folder and portable pack persistence', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-persistence-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('round-trips a content-addressed project folder and ZIP64 pack', async () => {
    const source = join(root, 'source.wav');
    const bytes = Buffer.from('controlled-media');
    await writeFile(source, bytes);
    const project = createProject('song', 'Persistence Song');
    const asset: MediaAsset = {
      ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: 'Source', mimeType: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length, storage: 'managed-cache', externalPath: source, source: 'import', sampleRate: 48_000, channels: 2, durationSamples: 100,
    };
    project.assets[asset.id] = asset;
    const saved = await saveProjectFolder(project, join(root, 'Daily Project'), { appVersion: 'test', resolveAssetSource: async () => source, traceNdjson: '{"trace":true}\n' });
    expect(saved.projectPath.endsWith('.aimuse')).toBe(true);
    expect(saved.warnings).toEqual([]);
    const loaded = await readProjectFolder(saved.projectPath);
    expect(loaded.project.name).toBe('Persistence Song');
    expect(loaded.project.assets[asset.id].storage).toBe('embedded');
    expect(loaded.warnings).toEqual([]);
    const pack = await packProjectFolder(saved.projectPath, join(root, 'portable'));
    const unpacked = await unpackProjectPack(pack, join(root, 'Unpacked.aimuse'));
    const reopened = await readProjectFolder(unpacked);
    expect(reopened.project.id).toBe(project.id);
    expect(await readFile(join(unpacked, 'assets', asset.sha256))).toEqual(bytes);
  });

  it('resolves recovered media before rewriting its descriptor and preserves unavailable references', async () => {
    const source = join(root, 'recovered.wav');
    const bytes = Buffer.from('recovered managed media');
    await writeFile(source, bytes);
    const project = createProject('song', 'Recovered');
    const asset: MediaAsset = { ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: 'Recovered source', mimeType: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, storage: 'managed-cache', externalPath: source, source: 'import' };
    project.assets[asset.id] = asset;
    const saved = await saveProjectFolder(project, join(root, 'Recovered'), { appVersion: 'test', resolveAssetSource: async (original) => original.externalPath });
    expect(saved.warnings).toEqual([]);
    expect(await readFile(join(saved.projectPath, 'assets', asset.sha256))).toEqual(bytes);
    expect((await readProjectFolder(saved.projectPath)).project.assets[asset.id].storage).toBe('embedded');
    expect(project.assets[asset.id]).toEqual(asset);

    await rm(source);
    const unavailable = await saveProjectFolder(project, join(root, 'Unavailable'), { appVersion: 'test', resolveAssetSource: async (original) => original.externalPath });
    expect(unavailable.warnings).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(unavailable.projectPath, 'project.json'), 'utf8'));
    expect(persisted.assets[asset.id]).toMatchObject({ storage: 'managed-cache', externalPath: source });
  });

  it('keeps the previous atomic file when validation rejects a replacement', async () => {
    const path = join(root, 'atomic.json');
    await atomicWriteFile(path, '{"valid":true}');
    await expect(atomicWriteFile(path, '{broken', () => { throw new Error('invalid'); })).rejects.toThrow('invalid');
    expect(await readFile(path, 'utf8')).toBe('{"valid":true}');
  });

  it('syncs the containing directory only after the atomic rename is visible', async () => {
    const path = join(root, 'durable.json');
    const observations: string[] = [];
    await atomicWriteFile(path, '{"durable":true}', undefined, {
      syncDirectory: async (directory) => {
        observations.push(directory);
        expect(await readFile(path, 'utf8')).toBe('{"durable":true}');
      },
    });
    expect(observations).toEqual([root]);
  });

  it('can stage outside a strict authority directory and syncs both rename directories', async () => {
    const authority = join(root, 'authority');
    const staging = join(root, 'staging');
    const path = join(authority, 'protected.json');
    const observations: string[] = [];
    await atomicWriteFile(path, '{"protected":true}', undefined, {
      temporaryDirectory: staging,
      syncDirectory: async (directory) => {
        observations.push(directory);
        expect(await readFile(path, 'utf8')).toBe('{"protected":true}');
      },
    });
    expect(observations).toEqual([authority, staging]);
    expect(await readdir(authority)).toEqual(['protected.json']);
    expect(await readdir(staging)).toEqual([]);
  });

  it.each([
    ['interrupted', true],
    ['silently truncated', false],
  ])('cleans credential-bearing stages and preserves the previous connection after an %s write', async (_case, throwAfterPartial) => {
    const path = join(root, 'qa-connection.json');
    const knownGood = '{"sentinel":"known-good-connection"}\n';
    const credential = 'fake-test-credential-must-not-remain';
    const replacement = `${JSON.stringify({ version: 1, token: credential, pid: 1234 })}\n`;
    await atomicWriteFile(path, knownGood);

    await expect(atomicWriteFile(path, replacement, undefined, {
      write: async (handle, data) => {
        const bytes = Buffer.from(data);
        await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        if (throwAfterPartial) throw new Error('injected interrupted connection write');
      },
    })).rejects.toThrow(throwAfterPartial ? 'injected interrupted connection write' : 'Atomic staging verification failed');

    expect(await readFile(path, 'utf8')).toBe(knownGood);
    expect(await readdir(root)).toEqual(['qa-connection.json']);
    expect(await readFile(path, 'utf8')).not.toContain(credential);
  });

  it('rejects project asset paths that escape the working folder', async () => {
    const project = createProject('song', 'Traversal');
    const saved = await saveProjectFolder(project, join(root, 'Traversal.aimuse'), { appVersion: 'test' });
    const projectPath = join(saved.projectPath, 'project.json');
    const stored = JSON.parse(await readFile(projectPath, 'utf8')) as typeof project;
    const malicious: MediaAsset = { ...entityBase('asset'), kind: 'analysis', name: 'escape', mimeType: 'application/json', sha256: '0'.repeat(64), byteLength: 0, storage: 'embedded', relativePath: '../outside', source: 'system' };
    stored.assets[malicious.id] = malicious;
    await writeFile(projectPath, JSON.stringify(stored));
    await expect(readProjectFolder(saved.projectPath)).rejects.toThrow('escapes the project');
  });

  it('never silently overwrites an unpack destination', async () => {
    const project = createProject('sfx', 'Pack');
    const saved = await saveProjectFolder(project, join(root, 'Pack.aimuse'), { appVersion: 'test' });
    const pack = await packProjectFolder(saved.projectPath, join(root, 'Pack.aimusepack'));
    const destination = join(root, 'Destination.aimuse');
    await writeFile(destination, 'occupied');
    await expect(unpackProjectPack(pack, destination)).rejects.toThrow('already exists');
  });
});
