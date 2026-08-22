import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { resolveSubjectPath, verifyPackageSubject } from './package-subject.mjs';

if (process.platform !== 'win32' && process.platform !== 'darwin') {
  process.stderr.write(`AIMuse package verification is unsupported on ${process.platform}.\n`);
  process.exit(1);
}

const outDir = resolve(process.env.AIMUSE_FORGE_OUT_DIR || 'out');
const subjectBinding = process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST
  ? await verifyPackageSubject({
      manifestPath: process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST,
      expectedManifestSha256: process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256,
    })
  : undefined;
const packageArchitecture = subjectBinding?.manifest.subject.architecture || process.env.AIMUSE_VERIFY_PACKAGE_ARCH || process.arch;
const expectedMacArchitectures = packageArchitecture === 'universal'
  ? ['arm64', 'x86_64']
  : packageArchitecture === 'x64' ? ['x86_64'] : packageArchitecture === 'arm64' ? ['arm64'] : [];
if (process.platform === 'darwin' && expectedMacArchitectures.length === 0) {
  process.stderr.write(`AIMuse package verification does not support Darwin architecture ${packageArchitecture}.\n`);
  process.exit(1);
}
const packageDir = subjectBinding ? resolveSubjectPath(process.cwd(), subjectBinding.manifest.subject.packageDirectory) : join(outDir, `AIMuse-${process.platform}-${packageArchitecture}`);
const app = subjectBinding ? resolveSubjectPath(process.cwd(), subjectBinding.manifest.subject.app) : process.platform === 'darwin' ? join(packageDir, 'AIMuse.app') : packageDir;
const executable = subjectBinding ? resolveSubjectPath(process.cwd(), subjectBinding.manifest.subject.files.applicationExecutable.path) : process.platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'AIMuse') : join(packageDir, 'AIMuse.exe');
const archive = subjectBinding ? resolveSubjectPath(process.cwd(), subjectBinding.manifest.subject.files.applicationAsar.path) : join(process.platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(packageDir, 'resources'), 'app.asar');
const resources = dirname(archive);
const nativeDirectory = join(resources, 'native');
const nativeNames = ['aimuse-audio', 'aimuse-plugin-scanner', 'aimuse-plugin-bridge'].map((name) => process.platform === 'win32' ? `${name}.exe` : name);

function run(command, arguments_) {
  return spawnSync(command, arguments_, { encoding: 'utf8', shell: false, windowsHide: true });
}

function plistValue(infoPlist, key) {
  const result = run('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]);
  if (result.error || result.status !== 0) throw new Error(`Info.plist is missing ${key}.`);
  return result.stdout.trim();
}

function plistHasKey(infoPlist, key) {
  const result = run('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]);
  return !result.error && result.status === 0;
}

function machOArchitectures(filePath, label) {
  const architectureResult = run('lipo', ['-archs', filePath]);
  if (architectureResult.error || architectureResult.status !== 0) throw new Error(`${label} is not a readable Mach-O image.`);
  return architectureResult.stdout.trim().split(/\s+/u).filter(Boolean);
}

async function verifyMacPackage() {
  const infoPlist = join(app, 'Contents', 'Info.plist');
  await access(infoPlist);
  const bundleId = plistValue(infoPlist, 'CFBundleIdentifier');
  const bundleName = plistValue(infoPlist, 'CFBundleName');
  const iconFile = plistValue(infoPlist, 'CFBundleIconFile');
  const category = plistValue(infoPlist, 'LSApplicationCategoryType');
  const microphoneUsage = plistValue(infoPlist, 'NSMicrophoneUsageDescription');
  if (bundleId !== 'com.aimuse.app' || bundleName !== 'AIMuse' || !iconFile.endsWith('.icns') || category !== 'public.app-category.music' || !microphoneUsage.includes('explicitly authorize')) {
    throw new Error('macOS bundle identity, category or microphone disclosure does not match the package contract.');
  }
  for (const key of ['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription']) {
    if (plistHasKey(infoPlist, key)) throw new Error(`macOS bundle retains unused Electron usage description ${key}.`);
  }
  const packagedIcon = await readFile(join(resources, iconFile));
  const expectedIcon = await readFile(resolve('build', 'icon.icns'));
  if (!packagedIcon.equals(expectedIcon)) throw new Error('macOS bundle did not embed the repo-owned AIMuse icon.');
  const iconSha256 = createHash('sha256').update(packagedIcon).digest('hex').toUpperCase();

  const architectures = machOArchitectures(executable, 'Packaged AIMuse executable');
  if (architectures.length !== expectedMacArchitectures.length || expectedMacArchitectures.some((value) => !architectures.includes(value))) throw new Error(`Packaged AIMuse executable architectures ${architectures.join(', ')} do not exactly match ${packageArchitecture}.`);
  const nativeArchitectures = Object.fromEntries(nativeNames.map((name) => {
    const values = machOArchitectures(join(nativeDirectory, name), `Packaged native executable ${name}`);
    if (values.length !== expectedMacArchitectures.length || expectedMacArchitectures.some((value) => !values.includes(value))) throw new Error(`Packaged native executable ${name} architectures ${values.join(', ')} do not exactly match ${packageArchitecture}.`);
    return [name, values];
  }));

  const signatureDescription = run('codesign', ['-dvvv', app]);
  const signatureText = `${signatureDescription.stdout}${signatureDescription.stderr}`;
  const signatureKind = signatureDescription.status === 0
    ? signatureText.includes('Signature=adhoc') ? 'ad-hoc' : 'identity'
    : 'unsigned';
  const signatureVerification = run('codesign', ['--verify', '--deep', '--strict', app]);
  const signatureValid = signatureVerification.status === 0;
  if (!signatureValid) throw new Error('The macOS application code signature is missing or invalid.');
  const requireSigned = process.env.AIMUSE_REQUIRE_MACOS_SIGNED === '1';
  if (requireSigned && (!signatureValid || signatureKind !== 'identity')) throw new Error('A Developer ID signature was required but the .app is not identity-signed and valid.');

  const stapler = run('xcrun', ['stapler', 'validate', app]);
  const notarizationStapled = stapler.status === 0;
  if (process.env.AIMUSE_REQUIRE_MACOS_NOTARIZED === '1' && !notarizationStapled) throw new Error('A stapled notarization ticket was required but not present.');

  return { bundleId, bundleName, iconFile, iconSha256, category, architectures, nativeArchitectures, signatureKind, signatureValid, notarizationStapled };
}

try {
  await Promise.all([
    access(executable, constants.X_OK),
    access(archive),
    ...nativeNames.map((name) => access(join(nativeDirectory, name), constants.X_OK)),
  ]);
  const executableBytes = await readFile(executable);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  const archiveBytes = await readFile(archive);
  const native = await Promise.all(nativeNames.map(async (name) => {
    const bytes = await readFile(join(nativeDirectory, name));
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() };
  }));
  const minimumExecutableBytes = process.platform === 'darwin' ? 20_000 : 1_000_000;
  if (executableInfo.size < minimumExecutableBytes || archiveInfo.size < 1_000 || native.some((entry) => entry.bytes < 10_000)) throw new Error('One or more packaged files are unexpectedly small.');

  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  for (const required of ['/.vite/build/main.js', '/.vite/build/playback-render-worker.js', '/.vite/build/preload.js']) if (!archiveFiles.includes(required)) throw new Error(`Packaged runtime is missing ${required}.`);

  const fuses = await getCurrentFuseWire(executable);
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.DISABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
  for (const [option, state] of expected) if (fuses[option] !== state) throw new Error(`Electron fuse ${FuseV1Options[option]} is ${String(fuses[option])}, expected ${String(state)}.`);

  const macos = process.platform === 'darwin' ? await verifyMacPackage() : undefined;
  process.stdout.write(`${JSON.stringify({
    verified: true,
    platform: process.platform,
    architecture: packageArchitecture,
    node: process.version,
    packageDir,
    app,
    executable,
    executableBytes: executableInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
    appAsarSha256: createHash('sha256').update(archiveBytes).digest('hex').toUpperCase(),
    native,
    hardenedFuses: true,
    ...(subjectBinding ? {
      subjectManifest: subjectBinding.manifestPath,
      subjectManifestSha256: subjectBinding.manifestSha256,
      subjectIdentitySha256: subjectBinding.manifest.subject.identitySha256,
    } : {}),
    ...(macos ? { macos } : {}),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIMuse package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
