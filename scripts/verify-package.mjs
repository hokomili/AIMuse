import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

if (process.platform !== 'win32') {
  process.stderr.write('AIMuse package verification is currently Windows-only; macOS package verification requires a signed/notarized .app contract and is intentionally blocked.\n');
  process.exit(1);
}

const outDir = resolve(process.env.AIMUSE_FORGE_OUT_DIR || 'out');
const packageDir = join(outDir, 'AIMuse-win32-x64');
const executable = join(packageDir, 'AIMuse.exe');
const archive = join(packageDir, 'resources', 'app.asar');
const nativeDirectory = join(packageDir, 'resources', 'native');
const nativeNames = ['aimuse-audio.exe', 'aimuse-plugin-scanner.exe', 'aimuse-plugin-bridge.exe'];

try {
  await Promise.all([access(executable), access(archive), ...nativeNames.map((name) => access(join(nativeDirectory, name)))]);
  const executableBytes = await readFile(executable);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  const native = await Promise.all(nativeNames.map(async (name) => ({ name, bytes: (await stat(join(nativeDirectory, name))).size })));
  if (executableInfo.size < 1_000_000 || archiveInfo.size < 1_000 || native.some((entry) => entry.bytes < 10_000)) throw new Error('One or more packaged files are unexpectedly small.');

  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  for (const required of ['/.vite/build/main.js', '/.vite/build/playback-render-worker.js', '/.vite/build/preload.js']) if (!archiveFiles.includes(required)) throw new Error(`Packaged runtime is missing ${required}.`);

  const fuses = await getCurrentFuseWire(executable);
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
  for (const [option, state] of expected) if (fuses[option] !== state) throw new Error(`Electron fuse ${FuseV1Options[option]} is ${String(fuses[option])}, expected ${String(state)}.`);

  process.stdout.write(`${JSON.stringify({
    verified: true,
    node: process.version,
    packageDir,
    executable,
    executableBytes: executableInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
    native,
    hardenedFuses: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIMuse package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
