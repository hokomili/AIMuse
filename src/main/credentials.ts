import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GenerationProvider } from '@aimuse/core';
import { atomicWriteFile } from './persistence';

interface ProtectedFile { version: 1; values: Record<string, string> }
export interface ProtectedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export type CredentialFileWriter = (path: string, data: string, validate: (bytes: Buffer) => void) => Promise<void>;

export function protectedStorageLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Windows protected storage';
  if (platform === 'darwin') return 'macOS Keychain-backed protected storage';
  return 'Operating-system protected storage';
}

function parseProtectedFile(raw: string): ProtectedFile {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Protected credential file must be an object.');
  const candidate = parsed as { version?: unknown; values?: unknown };
  if (candidate.version !== 1 || !candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) throw new Error('Protected credential file has an unsupported schema.');
  const entries = Object.entries(candidate.values);
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('Protected credential values must be encrypted strings.');
  return { version: 1, values: Object.fromEntries(entries) as Record<string, string> };
}

class ProtectedStore {
  constructor(private readonly path: string, private readonly storage: ProtectedStorage, private readonly writer: CredentialFileWriter = atomicWriteFile) {}

  private async protectParent(): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(parent, 0o700);
  }

  private requireEncryption(): void {
    let available = false;
    try { available = this.storage.isEncryptionAvailable(); } catch { /* fail closed without surfacing protected-storage diagnostics */ }
    if (!available) throw new Error(`${protectedStorageLabel()} is unavailable.`);
  }

  protected async read(): Promise<Record<string, string>> {
    try {
      return parseProtectedFile(await readFile(this.path, 'utf8')).values;
    } catch { return {}; }
  }

  protected async write(values: Record<string, string>): Promise<void> {
    this.requireEncryption();
    const serialized = `${JSON.stringify({ version: 1, values } satisfies ProtectedFile, null, 2)}\n`;
    await this.protectParent();
    await this.writer(this.path, serialized, (bytes) => { parseProtectedFile(bytes.toString('utf8')); });
    if (process.platform !== 'win32') await chmod(this.path, 0o600);
  }

  protected encrypt(value: string): string {
    this.requireEncryption();
    try { return this.storage.encryptString(value).toString('base64'); }
    catch { throw new Error(`${protectedStorageLabel()} could not encrypt the credential.`); }
  }

  protected decrypt(value: string): string { return this.storage.decryptString(Buffer.from(value, 'base64')); }
}

export class LocalCredentialStore extends ProtectedStore {
  async loadOrCreateToken(): Promise<string> {
    const values = await this.read();
    if (values.token) {
      try { return this.decrypt(values.token); } catch { /* rotate an unreadable token */ }
    }
    const token = randomBytes(32).toString('base64url');
    await this.write({ token: this.encrypt(token) });
    return token;
  }
}

export class ProviderCredentialStore extends ProtectedStore {
  async set(provider: GenerationProvider, value: string): Promise<void> {
    const values = await this.read();
    if (value) values[provider] = this.encrypt(value); else delete values[provider];
    await this.write(values);
  }

  async get(provider: GenerationProvider): Promise<string | undefined> {
    const value = (await this.read())[provider];
    if (!value) return undefined;
    try { return this.decrypt(value); } catch { return undefined; }
  }

  async status(): Promise<Record<GenerationProvider, boolean>> {
    return { elevenlabs: Boolean(await this.get('elevenlabs')), stability: Boolean(await this.get('stability')), lyria: Boolean(await this.get('lyria')) };
  }
}
