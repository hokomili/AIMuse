import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

type RootPackage = {
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  scripts?: Record<string, string>;
};

type RootLock = {
  packages?: Record<string, {
    devDependencies?: Record<string, string>;
    name?: string;
    version?: string;
    link?: boolean;
    optional?: boolean;
  }>;
};

type ExtractZipModule = {
  default: (zipPath: string, options: { dir: string }) => Promise<void>;
};

type TarModule = {
  c: (options: { cwd: string; file: string }, files: string[]) => Promise<void>;
  x: (options: { cwd: string; file: string }) => Promise<void>;
};

type TmpModule = {
  dirSync: (options: { unsafeCleanup: true }) => { name: string; removeCallback: () => void };
};

const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as RootPackage;
const rootLock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as RootLock;

describe('release dependency-security gate', () => {
  it('pins the supported Electron runtime and patched build-tool substitutions', () => {
    expect(rootPackage.devDependencies?.electron).toBe('43.6.0');
    expect(rootPackage.overrides).toEqual({
      'extract-zip': 'npm:@electron-internal/extract-zip@1.0.5',
      tar: '7.5.22',
      tmp: '0.2.7',
    });
    expect(rootLock.packages?.['']?.devDependencies?.electron).toBe('43.6.0');
    expect(rootLock.packages?.['node_modules/electron']?.version).toBe('43.6.0');
    expect(rootLock.packages?.['node_modules/extract-zip']).toMatchObject({
      name: '@electron-internal/extract-zip',
      version: '1.0.5',
    });
    expect(rootLock.packages?.['node_modules/tar']?.version).toBe('7.5.22');
    expect(rootLock.packages?.['node_modules/tmp']?.version).toBe('0.2.7');
  });

  it('checks installed package versions directly instead of trusting npm hidden-lock metadata', () => {
    let inspected = 0;
    for (const [path, locked] of Object.entries(rootLock.packages ?? {})) {
      if (!path || locked.link) continue;
      const manifestPath = resolve(path, 'package.json');
      if (!existsSync(manifestPath) && locked.optional) continue;
      expect(existsSync(manifestPath), `Required installed package is missing: ${path}`).toBe(true);
      const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
      expect(installed.version, `Installed bytes do not match the locked version: ${path}`).toBe(locked.version);
      inspected++;
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('cannot omit build or packaging dependencies from the release audit', () => {
    expect(rootPackage.scripts?.['audit:runtime']).toBe('npm audit --omit=dev --audit-level=high');
    expect(rootPackage.scripts?.['audit:complete']).toBe(
      'npm audit --include=prod --include=dev --include=optional --include=peer --audit-level=high',
    );
    expect(rootPackage.scripts?.['audit:release']).toBe('npm run audit:runtime && npm run audit:complete');
    expect(rootPackage.scripts?.['release:windows']).toContain('npm run audit:release');
    expect(rootPackage.scripts?.['release:windows']).not.toContain('npm audit --omit=dev');
  });

  it('keeps the existing Forge consumers compatible with each patched substitution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-release-security-'));
    try {
      const zipPath = join(root, 'payload.zip');
      const zipOutput = join(root, 'zip-output');
      await mkdir(zipOutput);
      await writeFile(zipPath, zipSync({ 'payload.txt': strToU8('safe zip payload') }));

      const packagerRequire = createRequire(resolve('node_modules/@electron/packager/package.json'));
      const extractZip = (packagerRequire('extract-zip') as ExtractZipModule).default;
      await extractZip(zipPath, { dir: zipOutput });
      expect(await readFile(join(zipOutput, 'payload.txt'), 'utf8')).toBe('safe zip payload');

      const tarInput = join(root, 'tar-input');
      const tarOutput = join(root, 'tar-output');
      const tarPath = join(root, 'payload.tar');
      await mkdir(tarInput);
      await mkdir(tarOutput);
      await writeFile(join(tarInput, 'payload.txt'), 'safe tar payload');

      const rebuildRequire = createRequire(resolve('node_modules/@electron/rebuild/package.json'));
      const nodeGypRequire = createRequire(resolve('node_modules/@electron/node-gyp/package.json'));
      const rebuildTar = rebuildRequire('tar') as TarModule;
      const nodeGypTar = nodeGypRequire('tar') as TarModule;
      await rebuildTar.c({ cwd: tarInput, file: tarPath }, ['payload.txt']);
      await nodeGypTar.x({ cwd: tarOutput, file: tarPath });
      expect(await readFile(join(tarOutput, 'payload.txt'), 'utf8')).toBe('safe tar payload');

      const editorRequire = createRequire(resolve('node_modules/external-editor/package.json'));
      const temporary = (editorRequire('tmp') as TmpModule).dirSync({ unsafeCleanup: true });
      expect(temporary.name).toContain(tmpdir());
      temporary.removeCallback();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
