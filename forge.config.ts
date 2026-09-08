import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import soundFontManifest from './build/soundfonts/manifest.json';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const macosDeveloperIdentity = process.env.AIMUSE_MACOS_SIGN_IDENTITY;
const macosSigningIdentity = macosDeveloperIdentity || '-';
const macosAdHocSigning = !macosDeveloperIdentity;
const macosEntitlements = resolve('build', 'entitlements.mac.plist');
const macosInheritedEntitlements = resolve('build', 'entitlements.mac.inherit.plist');
const macosDevelopmentEntitlements = resolve('build', 'entitlements.mac.development.plist');
const macosDevelopmentInheritedEntitlements = resolve('build', 'entitlements.mac.development.inherit.plist');
const nativeDistribution = resolve(process.env.AIMUSE_NATIVE_DIST_DIR || 'native/dist/native');
const macosNotarization = macosDeveloperIdentity && process.env.AIMUSE_APPLE_ID && process.env.AIMUSE_APPLE_APP_PASSWORD && process.env.AIMUSE_APPLE_TEAM_ID
  ? { appleId: process.env.AIMUSE_APPLE_ID, appleIdPassword: process.env.AIMUSE_APPLE_APP_PASSWORD, teamId: process.env.AIMUSE_APPLE_TEAM_ID }
  : undefined;
let activeMacPackageArchitecture: string | undefined;

function requiredMacArchitectures(architecture: string): string[] {
  if (architecture === 'arm64') return ['arm64'];
  if (architecture === 'x64') return ['x86_64'];
  if (architecture === 'universal') return ['arm64', 'x86_64'];
  throw new Error(`AIMuse macOS packaging does not support architecture ${architecture}.`);
}

function runRequired(program: string, arguments_: string[], failure: string): string {
  const result = spawnSync(program, arguments_, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${failure}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout.trim();
}

export function validateSoundFontResources(directory: string): void {
  for (const file of soundFontManifest.files) {
    const bytes = readFileSync(resolve(directory, file.name));
    if (bytes.byteLength !== file.byteLength || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Packaged SoundFont resource failed verification: ${file.name}`);
  }
}

function validatePackagedNativeArchitectures(nativeDirectory: string, architecture: string): void {
  const required = requiredMacArchitectures(architecture);
  for (const name of ['aimuse-audio', 'aimuse-plugin-scanner', 'aimuse-plugin-bridge']) {
    const filePath = resolve(nativeDirectory, name);
    const actual = runRequired('lipo', ['-archs', filePath], `Could not inspect packaged native executable ${name}`).split(/\s+/u);
    for (const value of required) if (!actual.includes(value)) throw new Error(`Packaged native executable ${name} does not contain required ${value} code for ${architecture}.`);
  }
}

export function packagedElectronExecutable(buildPath: string, platform: string): string {
  if (platform === 'win32') return resolve(buildPath, '..', '..', 'electron.exe');
  if (platform === 'darwin') return resolve(buildPath, '..', '..', 'MacOS', 'AIMuse');
  throw new Error(`AIMuse packaging is unsupported on ${platform}.`);
}

function removeUnusedMacUsageDescriptions(buildPath: string): void {
  const infoPlist = resolve(buildPath, '..', '..', 'Info.plist');
  for (const key of ['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription']) {
    const present = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], { encoding: 'utf8', shell: false });
    if (present.status !== 0) continue;
    const removed = spawnSync('plutil', ['-remove', key, infoPlist], { encoding: 'utf8', shell: false });
    if (removed.error || removed.status !== 0) throw new Error(`Could not remove unused macOS usage description ${key}.`);
  }
}

const config: ForgeConfig = {
  outDir: resolve(process.env.AIMUSE_FORGE_OUT_DIR || 'out'),
  packagerConfig: {
    asar: true,
    prune: false,
    executableName: 'AIMuse',
    appBundleId: 'com.aimuse.app',
    helperBundleId: 'com.aimuse.app.helper',
    appCategoryType: 'public.app-category.music',
    ...(process.platform === 'darwin' ? { icon: resolve('build', 'icon.icns') } : {}),
    extendInfo: {
      // LaunchServices must never infer a foreground role before the main
      // process has admitted an editor. Interactive startup promotes itself
      // explicitly immediately before creating its BrowserWindow.
      LSUIElement: true,
      NSMicrophoneUsageDescription: 'AIMuse accesses the microphone only after you explicitly authorize and start recording.',
    },
    extraResource: [nativeDistribution, resolve('build', 'soundfonts')],
    afterCopyExtraResources: [(buildPath, _electronVersion, platform, architecture, callback) => {
      try {
        validateSoundFontResources(platform === 'darwin' ? resolve(buildPath, 'AIMuse.app', 'Contents', 'Resources', 'soundfonts') : resolve(buildPath, 'resources', 'soundfonts'));
        if (platform === 'darwin') validatePackagedNativeArchitectures(resolve(buildPath, 'AIMuse.app', 'Contents', 'Resources', 'native'), activeMacPackageArchitecture ?? architecture);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }],
    ...(process.platform === 'darwin' ? {
      osxSign: {
        identity: macosSigningIdentity,
        identityValidation: !macosAdHocSigning,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: (filePath: string) => ({
          entitlements: filePath.endsWith('AIMuse.app')
            ? macosAdHocSigning ? macosDevelopmentEntitlements : macosEntitlements
            : macosAdHocSigning ? macosDevelopmentInheritedEntitlements : macosInheritedEntitlements,
          hardenedRuntime: true,
          ...(macosAdHocSigning ? { timestamp: 'none' } : {}),
        }),
      },
    } : {}),
    ...(macosNotarization ? { osxNotarize: macosNotarization } : {}),
  },
  rebuildConfig: { onlyModules: [] },
  makers: [new MakerSquirrel({ name: 'aimuse', setupExe: 'AIMuse-Setup.exe' }), new MakerZIP({}, ['win32', 'darwin'])],
  hooks: {
    prePackage: async (_config, platform, architecture) => {
      validateSoundFontResources(resolve('build', 'soundfonts'));
      if (platform !== 'darwin') return;
      if (process.platform !== 'darwin') throw new Error('macOS native package assets must be built on Darwin.');
      requiredMacArchitectures(architecture);
      activeMacPackageArchitecture = architecture;
      runRequired(process.execPath, [resolve('scripts', 'native-build.mjs'), 'build', `--arch=${architecture}`], `Could not build ${architecture} macOS native package assets`);
    },
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform) => {
      if (platform !== 'win32' && platform !== 'darwin') throw new Error(`AIMuse package hardening is unsupported on ${platform}.`);
      if (platform === 'darwin') {
        removeUnusedMacUsageDescriptions(buildPath);
      }
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
      await flipFuses(packagedElectronExecutable(buildPath, platform), { version: FuseVersion.V1, strictlyRequireAllFuses: true, [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableCookieEncryption]: false, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true, [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false, [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, [FuseV1Options.WasmTrapHandlers]: true });
    },
  },
  plugins: [new VitePlugin({ build: [{ entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' }, { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' }], renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }] })],
};
export default config;
