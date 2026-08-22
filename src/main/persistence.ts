import archiver from 'archiver';
import yauzl from 'yauzl';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { migrateProject, validateProject, type AIMuseProject, type MediaAsset } from '@aimuse/core';
import { z } from 'zod';
import type { FileSavedAuditEvent } from '../common/contracts';

export interface ProjectManifest {
  format: 'AIMuse';
  schemaVersion: 1;
  projectId: string;
  name: string;
  kind: AIMuseProject['kind'];
  revision: number;
  appVersion: string;
  savedAt: string;
  assetCount: number;
  totalAssetBytes: number;
}

export interface SaveProjectOptions {
  appVersion: string;
  resolveAssetSource?: (asset: MediaAsset) => Promise<string | undefined>;
  traceNdjson?: string;
  fileAuditNdjson?: string;
}

export interface LoadedProject {
  project: AIMuseProject;
  manifest: ProjectManifest;
  fileAudit: FileSavedAuditEvent[];
  warnings: string[];
}

const FileSavedAuditSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  type: z.literal('file.saved'),
  projectId: z.string().min(1),
  actor: z.object({
    id: z.string().min(1), kind: z.enum(['human', 'agent', 'system']), name: z.string().min(1), color: z.string().min(1),
    client: z.object({ product: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), taskId: z.string().optional(), version: z.string().optional() }).strict().optional(),
  }).strict(),
  recordedAt: z.string().datetime(),
  outcome: z.literal('succeeded'),
}).strict();

function ensureProjectExtension(folderPath: string): string {
  return extname(folderPath).toLowerCase() === '.aimuse' ? resolve(folderPath) : resolve(`${folderPath}.aimuse`);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => { hash.update(chunk); byteLength += Buffer.byteLength(chunk); });
    stream.once('error', reject); stream.once('end', resolvePromise);
  });
  return { sha256: hash.digest('hex'), byteLength };
}

export interface AtomicWriteFileHooks {
  write?: (handle: FileHandle, data: Uint8Array | string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
  temporaryDirectory?: string;
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function atomicWriteFile(path: string, data: Uint8Array | string, validate?: (bytes: Buffer) => void, hooks: AtomicWriteFileHooks = {}): Promise<void> {
  const targetDirectory = dirname(path);
  const temporaryDirectory = hooks.temporaryDirectory ?? targetDirectory;
  await mkdir(targetDirectory, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = join(temporaryDirectory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`);
  const expected = Buffer.from(data);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  let committed = false;
  let operationError: unknown;
  try {
    handle = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    await (hooks.write ?? ((file, value) => file.writeFile(value)))(handle, data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const bytes = await readFile(temporary);
    if (!bytes.equals(expected)) throw new Error(`Atomic staging verification failed for ${path}.`);
    validate?.(bytes);
    await rename(temporary, path);
    if (hooks.syncDirectory) {
      await hooks.syncDirectory(targetDirectory);
      if (temporaryDirectory !== targetDirectory) await hooks.syncDirectory(temporaryDirectory);
    } else if (process.platform !== 'win32') {
      await syncDirectory(targetDirectory);
      if (temporaryDirectory !== targetDirectory) await syncDirectory(temporaryDirectory);
    }
    committed = true;
  } catch (error) {
    operationError = error;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (error) { operationError ??= error; }
    }
    if (temporaryCreated && !committed) {
      try { await rm(temporary, { force: true }); } catch (error) {
        operationError = operationError
          ? new AggregateError([operationError, error], `Atomic write and cleanup failed for ${path}.`)
          : error;
      }
    }
  }
  if (operationError) throw operationError;
}

export async function saveProjectFolder(project: AIMuseProject, requestedPath: string, options: SaveProjectOptions): Promise<{ projectPath: string; warnings: string[] }> {
  const projectPath = ensureProjectExtension(requestedPath);
  await mkdir(projectPath, { recursive: true });
  for (const directory of ['assets', 'takes', 'plugin-state', 'peaks', 'analysis', 'activity', 'trace', 'recovery', 'preview']) await mkdir(join(projectPath, directory), { recursive: true });
  const warnings: string[] = [];
  const persisted = structuredClone(project);
  persisted.projectPath = undefined;
  persisted.dirty = false;
  for (const asset of Object.values(persisted.assets)) {
    if (asset.storage === 'linked') continue;
    const destination = join(projectPath, 'assets', asset.sha256);
    asset.relativePath = relative(projectPath, destination).split(sep).join('/');
    asset.externalPath = undefined;
    asset.storage = 'embedded';
    if (await exists(destination)) continue;
    const source = await options.resolveAssetSource?.(asset);
    if (!source || !(await exists(source))) { warnings.push(`Media unavailable while saving: ${asset.name}`); continue; }
    const actual = await sha256File(source);
    if (actual.sha256.toLowerCase() !== asset.sha256.toLowerCase() || actual.byteLength !== asset.byteLength) {
      warnings.push(`Media changed and was not embedded: ${asset.name}`); continue;
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    await copyFile(source, temporary);
    await rename(temporary, destination);
  }
  const manifest: ProjectManifest = {
    format: 'AIMuse', schemaVersion: 1, projectId: persisted.id, name: persisted.name, kind: persisted.kind,
    revision: persisted.revision, appVersion: options.appVersion, savedAt: new Date().toISOString(),
    assetCount: Object.keys(persisted.assets).length, totalAssetBytes: Object.values(persisted.assets).reduce((sum, asset) => sum + asset.byteLength, 0),
  };
  await atomicWriteFile(join(projectPath, 'project.json'), `${JSON.stringify(persisted, null, 2)}\n`, (bytes) => { validateProject(JSON.parse(bytes.toString('utf8'))); });
  await atomicWriteFile(join(projectPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, (bytes) => {
    const value = JSON.parse(bytes.toString('utf8')) as ProjectManifest;
    if (value.format !== 'AIMuse' || value.schemaVersion !== 1 || value.projectId !== project.id) throw new Error('Invalid AIMuse manifest.');
  });
  await atomicWriteFile(join(projectPath, 'activity', 'activity.jsonl'), persisted.activity.map((entry) => JSON.stringify(entry)).join('\n') + (persisted.activity.length ? '\n' : ''));
  if (options.traceNdjson !== undefined) await atomicWriteFile(join(projectPath, 'trace', 'transactions.jsonl'), options.traceNdjson);
  if (options.fileAuditNdjson !== undefined) await atomicWriteFile(join(projectPath, 'activity', 'file-audit.jsonl'), options.fileAuditNdjson, (bytes) => {
    parseFileAuditNdjson(bytes.toString('utf8'), project.id);
  });
  return { projectPath, warnings };
}

function parseFileAuditNdjson(raw: string, expectedProjectId: string): FileSavedAuditEvent[] {
  const entries: FileSavedAuditEvent[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const entry = FileSavedAuditSchema.parse(JSON.parse(line)) as FileSavedAuditEvent;
    if (entry.projectId !== expectedProjectId) throw new Error('File audit project identity does not match the project.');
    entries.push(entry);
  }
  return entries;
}

export async function readProjectFileAudit(requestedPath: string, expectedProjectId: string): Promise<FileSavedAuditEvent[]> {
  const projectPath = ensureProjectExtension(requestedPath);
  try { return parseFileAuditNdjson(await readFile(join(projectPath, 'activity', 'file-audit.jsonl'), 'utf8'), expectedProjectId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readProjectFolder(requestedPath: string): Promise<LoadedProject> {
  const projectPath = resolve(requestedPath);
  const info = await stat(projectPath);
  if (!info.isDirectory()) throw new Error('An AIMuse working project must be a folder.');
  const rawManifest = JSON.parse(await readFile(join(projectPath, 'manifest.json'), 'utf8')) as ProjectManifest;
  if (rawManifest.format !== 'AIMuse' || rawManifest.schemaVersion !== 1) throw new Error('Unsupported AIMuse project manifest.');
  const project = migrateProject(JSON.parse(await readFile(join(projectPath, 'project.json'), 'utf8')));
  if (project.id !== rawManifest.projectId) throw new Error('Project and manifest identities do not match.');
  const fileAudit = await readProjectFileAudit(projectPath, project.id);
  project.projectPath = projectPath;
  project.dirty = false;
  const warnings: string[] = [];
  for (const asset of Object.values(project.assets)) {
    if (asset.storage === 'linked') {
      if (!asset.externalPath || !(await exists(asset.externalPath))) warnings.push(`Linked media is missing: ${asset.name}`);
      continue;
    }
    const assetPath = resolve(projectPath, asset.relativePath ?? join('assets', asset.sha256));
    const relativePath = relative(projectPath, assetPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`Asset path escapes the project: ${asset.name}`);
    if (!(await exists(assetPath))) { warnings.push(`Embedded media is missing: ${asset.name}`); continue; }
    const actual = await sha256File(assetPath);
    if (actual.sha256.toLowerCase() !== asset.sha256.toLowerCase()) warnings.push(`Embedded media hash mismatch: ${asset.name}`);
  }
  return { project, manifest: rawManifest, fileAudit, warnings };
}

export async function packProjectFolder(projectPath: string, destinationPath: string): Promise<string> {
  const source = resolve(projectPath);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) throw new Error('Only an AIMuse working folder can be packed.');
  const destination = extname(destinationPath).toLowerCase() === '.aimusepack' ? resolve(destinationPath) : resolve(`${destinationPath}.aimusepack`);
  if (await exists(destination)) throw new Error('Portable pack destination already exists.');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 6 }, forceZip64: true });
    output.once('close', resolvePromise); output.once('error', reject); archive.once('error', reject);
    archive.pipe(output); archive.directory(source, false); void archive.finalize();
  });
  await rename(temporary, destination);
  return destination;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error('Unable to open archive.')) : resolvePromise(zip)));
}

function safeArchiveEntry(name: string): string {
  const normalized = normalize(name.replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('..') || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) throw new Error(`Unsafe archive entry: ${name}`);
  return normalized;
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('Unable to read archive entry.')) : resolvePromise(stream)));
}

export type ProjectPackUnpackEffect =
  | { phase: 'archive-read'; state: 'started' | 'completed' }
  | { phase: 'destination'; state: 'root-created' | 'cleanup-started' | 'removed' | 'cleanup-failed' }
  | { phase: 'entry'; state: 'discovered' | 'started' | 'completed'; index: number; entryType: 'directory' | 'file' }
  | { phase: 'project-validation'; state: 'started' | 'completed' };

export interface UnpackProjectPackOptions {
  observe?: (effect: ProjectPackUnpackEffect) => void;
  openArchive?: (path: string, openDefault: (path: string) => Promise<yauzl.ZipFile>) => Promise<yauzl.ZipFile>;
  writeEntry?: (stream: NodeJS.ReadableStream, destination: string, writeDefault: (stream: NodeJS.ReadableStream, destination: string) => Promise<void>) => Promise<void>;
  removeDestination?: (path: string, removeDefault: (path: string) => Promise<void>) => Promise<void>;
}

function observeProjectPackUnpack(options: UnpackProjectPackOptions, effect: ProjectPackUnpackEffect): void {
  try { options.observe?.(effect); } catch { /* Progress reporting must not change persistence semantics. */ }
}

async function writeArchiveEntry(stream: NodeJS.ReadableStream, destination: string): Promise<void> {
  await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

async function removeUnpackDestination(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function unpackProjectPack(packPath: string, destinationRoot: string, options: UnpackProjectPackOptions = {}): Promise<string> {
  const source = resolve(packPath);
  const root = resolve(destinationRoot);
  observeProjectPackUnpack(options, { phase: 'archive-read', state: 'started' });
  if (!(await exists(source))) throw new Error('AIMuse pack does not exist.');
  if (await exists(root)) throw new Error('Unpack destination already exists.');
  await mkdir(root, { recursive: false });
  observeProjectPackUnpack(options, { phase: 'destination', state: 'root-created' });
  let zip: yauzl.ZipFile | undefined;
  let entries = 0; let totalBytes = 0;
  try {
    const archive = await (options.openArchive ? options.openArchive(source, openZip) : openZip(source));
    zip = archive;
    await new Promise<void>((resolvePromise, reject) => {
      archive.once('error', reject); archive.once('end', () => { observeProjectPackUnpack(options, { phase: 'archive-read', state: 'completed' }); resolvePromise(); });
      archive.on('entry', (entry) => {
        void (async () => {
          entries += 1; totalBytes += entry.uncompressedSize;
          const entryType = /\/$/.test(entry.fileName) ? 'directory' : 'file';
          observeProjectPackUnpack(options, { phase: 'entry', state: 'discovered', index: entries - 1, entryType });
          if (entries > 100_000 || totalBytes > 1024 ** 4) throw new Error('Archive exceeds AIMuse extraction limits.');
          if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 2_000) throw new Error('Archive compression ratio is unsafe.');
          const name = safeArchiveEntry(entry.fileName);
          const destination = resolve(root, name);
          const relativePath = relative(root, destination);
          if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`Archive entry escapes destination: ${entry.fileName}`);
          observeProjectPackUnpack(options, { phase: 'entry', state: 'started', index: entries - 1, entryType });
          if (entryType === 'directory') await mkdir(destination, { recursive: true });
          else {
            await mkdir(dirname(destination), { recursive: true });
            const stream = await entryStream(archive, entry);
            await (options.writeEntry ? options.writeEntry(stream, destination, writeArchiveEntry) : writeArchiveEntry(stream, destination));
          }
          observeProjectPackUnpack(options, { phase: 'entry', state: 'completed', index: entries - 1, entryType });
          archive.readEntry();
        })().catch(reject);
      });
      archive.readEntry();
    });
    observeProjectPackUnpack(options, { phase: 'project-validation', state: 'started' });
    await readProjectFolder(root);
    observeProjectPackUnpack(options, { phase: 'project-validation', state: 'completed' });
    return root;
  } catch (error) {
    zip?.close();
    observeProjectPackUnpack(options, { phase: 'destination', state: 'cleanup-started' });
    try {
      await (options.removeDestination ? options.removeDestination(root, removeUnpackDestination) : removeUnpackDestination(root));
      observeProjectPackUnpack(options, { phase: 'destination', state: 'removed' });
    } catch (cleanupError) {
      observeProjectPackUnpack(options, { phase: 'destination', state: 'cleanup-failed' });
      throw cleanupError;
    }
    throw error;
  }
}

export async function canonicalizePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); } catch {
    const parts = [basename(absolute)]; let cursor = dirname(absolute);
    while (true) {
      try { return resolve(await realpath(cursor), ...parts); } catch {
        const parent = dirname(cursor); if (parent === cursor) return absolute; parts.unshift(basename(cursor)); cursor = parent;
      }
    }
  }
}
