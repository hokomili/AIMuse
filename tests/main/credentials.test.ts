import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerationRequest } from '../../src/common/generation';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ProviderCredentialStore, type CredentialFileWriter, type ProtectedStorage } from '../../src/main/credentials';
import { GenerationManager } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { atomicWriteFile } from '../../src/main/persistence';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

interface StorageFaults { available: boolean; encryptionThrows?: boolean; decryptionThrows?: boolean }

function protectedStorageMock(faults: StorageFaults): ProtectedStorage {
  const plaintext = new Map<string, string>();
  let sequence = 0;
  return {
    isEncryptionAvailable: () => faults.available,
    encryptString: (value) => {
      if (faults.encryptionThrows) throw new Error(`Injected encryption failure echoed ${value}`);
      const cipher = Buffer.from(`test-cipher-${sequence += 1}`);
      plaintext.set(cipher.toString('base64'), value);
      return cipher;
    },
    decryptString: (value) => {
      if (!faults.available || faults.decryptionThrows) throw new Error('Injected decryption failure.');
      const decrypted = plaintext.get(value.toString('base64'));
      if (decrypted === undefined) throw new Error('Injected protected storage cannot decrypt this value.');
      return decrypted;
    },
  };
}

describe('protected provider credential lifecycle', () => {
  let root: string;
  let path: string;
  let storage: ProtectedStorage;
  let faults: StorageFaults;
  let audio: AudioEngineController | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-provider-credentials-'));
    path = join(root, 'credentials', 'providers.json');
    faults = { available: true };
    storage = protectedStorageMock(faults);
  });

  afterEach(async () => {
    await audio?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('rotates and removes one provider atomically without exposing plaintext or disturbing another provider', async () => {
    const store = new ProviderCredentialStore(path, storage);
    const first = 'fixture-elevenlabs-secret-v1-never-persist';
    const rotated = 'fixture-elevenlabs-secret-v2-never-persist';
    const stability = 'fixture-stability-secret-never-persist';

    await store.set('elevenlabs', first);
    await store.set('stability', stability);
    await store.set('elevenlabs', rotated);

    expect(await store.get('elevenlabs')).toBe(rotated);
    expect(await store.get('stability')).toBe(stability);
    expect(await store.status()).toEqual({ elevenlabs: true, stability: true, lyria: false });
    let persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(first);
    expect(persisted).not.toContain(rotated);
    expect(persisted).not.toContain(stability);

    await store.set('elevenlabs', '');

    expect(await store.get('elevenlabs')).toBeUndefined();
    expect(await store.get('stability')).toBe(stability);
    expect(await store.status()).toEqual({ elevenlabs: false, stability: true, lyria: false });
    persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(first);
    expect(persisted).not.toContain(rotated);
    expect(persisted).not.toContain(stability);
    expect(await readdir(join(root, 'credentials'))).toEqual(['providers.json']);
  });

  it.each([
    ['rotation', 'fixture-interrupted-rotation-secret'],
    ['removal', ''],
  ] as const)('preserves the known-good encrypted set and cleans the stage after interrupted %s', async (_operation, replacement) => {
    const knownGood = new ProviderCredentialStore(path, storage);
    const original = 'fixture-known-good-secret-never-persist';
    const stability = 'fixture-unrelated-secret-never-persist';
    await knownGood.set('elevenlabs', original);
    await knownGood.set('stability', stability);
    const before = await readFile(path);

    const interruptedWriter: CredentialFileWriter = (target, data, validate) => atomicWriteFile(target, data, validate, {
      write: async (handle, staged) => {
        const bytes = Buffer.from(staged);
        await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        throw new Error('Injected interrupted provider credential write.');
      },
    });
    const interrupted = new ProviderCredentialStore(path, storage, interruptedWriter);

    await expect(interrupted.set('elevenlabs', replacement)).rejects.toThrow('Injected interrupted provider credential write.');
    expect(await readFile(path)).toEqual(before);
    expect(await knownGood.get('elevenlabs')).toBe(original);
    expect(await knownGood.get('stability')).toBe(stability);
    expect(await readdir(join(root, 'credentials'))).toEqual(['providers.json']);
    const persisted = (await readFile(path, 'utf8'));
    expect(persisted).not.toContain(original);
    expect(persisted).not.toContain(stability);
    if (replacement) expect(persisted).not.toContain(replacement);
  });

  it('fails unavailable rotation/removal closed without changing the known-good encrypted sentinel', async () => {
    const store = new ProviderCredentialStore(path, storage);
    const original = 'fixture-unavailable-known-good-never-persist';
    const replacement = 'fixture-unavailable-rotation-never-persist';
    await store.set('elevenlabs', original);
    const before = await readFile(path);
    faults.available = false;

    const rotationError = await store.set('elevenlabs', replacement).then(() => undefined, (error: unknown) => error as Error);
    const removalError = await store.set('elevenlabs', '').then(() => undefined, (error: unknown) => error as Error);

    expect(rotationError?.message).toBe('Windows protected storage is unavailable.');
    expect(removalError?.message).toBe('Windows protected storage is unavailable.');
    expect(`${rotationError?.message}${removalError?.message}`).not.toContain(original);
    expect(`${rotationError?.message}${removalError?.message}`).not.toContain(replacement);
    expect(await readFile(path)).toEqual(before);
    expect(await store.get('elevenlabs')).toBeUndefined();
    expect(await store.status()).toEqual({ elevenlabs: false, stability: false, lyria: false });
    expect(await readdir(join(root, 'credentials'))).toEqual(['providers.json']);
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(original);
    expect(persisted).not.toContain(replacement);
  });

  it('sanitizes encryption failure and does not configure or stage the rejected provider', async () => {
    const store = new ProviderCredentialStore(path, storage);
    const stability = 'fixture-encryption-existing-never-persist';
    const rejected = 'fixture-encryption-rejected-never-persist';
    await store.set('stability', stability);
    const before = await readFile(path);
    faults.encryptionThrows = true;

    const error = await store.set('elevenlabs', rejected).then(() => undefined, (failure: unknown) => failure as Error);

    expect(error?.message).toBe('Windows protected storage could not encrypt the credential.');
    expect(error?.message).not.toContain(rejected);
    expect(await readFile(path)).toEqual(before);
    expect(await store.status()).toEqual({ elevenlabs: false, stability: true, lyria: false });
    expect(await readdir(join(root, 'credentials'))).toEqual(['providers.json']);
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(stability);
    expect(persisted).not.toContain(rejected);
  });

  it('treats decryption failure as unconfigured and rejects generation before provider fetch', async () => {
    const store = new ProviderCredentialStore(path, storage);
    const secret = 'fixture-decryption-secret-never-expose';
    await store.set('elevenlabs', secret);
    const before = await readFile(path);
    faults.decryptionThrows = true;

    expect(await store.get('elevenlabs')).toBeUndefined();
    expect(await store.status()).toEqual({ elevenlabs: false, stability: false, lyria: false });

    audio = new AudioEngineController();
    const projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'runtime', 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'runtime', 'recovery')),
      trace: new TransactionTraceStore(join(root, 'runtime', 'traces')), audio,
    });
    await audio.start();
    await projects.initialize();
    const fetcher = vi.fn();
    const generation = new GenerationManager(join(root, 'runtime', 'generation'), projects, new AuthorityManager(), store, fetcher as typeof fetch);
    const request: GenerationRequest = {
      projectId: projects.getActiveProjectId()!, provider: 'elevenlabs', model: 'music_v1', kind: 'music',
      prompt: 'Test-owned instrumental', instrumental: true, durationMs: 3_000, resultCount: 1,
      referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', providerOptions: {},
    };

    expect((await generation.capabilities()).find((entry) => entry.provider === 'elevenlabs')?.configured).toBe(false);
    const error = await generation.start(request).then(() => undefined, (failure: unknown) => failure as Error);
    expect(error?.message).toBe('elevenlabs credentials are not configured.');
    expect(error?.message).not.toContain(secret);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(join(root, 'credentials'))).toEqual(['providers.json']);
    expect(await readFile(path, 'utf8')).not.toContain(secret);
  });
});
