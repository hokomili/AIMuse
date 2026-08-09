import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { resolve } from 'node:path';

export function packagedElectronExecutable(buildPath: string, platform: string): string {
  if (platform === 'win32') return resolve(buildPath, '..', '..', 'electron.exe');
  if (platform === 'darwin') return resolve(buildPath, '..', '..', 'MacOS', 'AIMuse');
  throw new Error(`AIMuse packaging is unsupported on ${platform}.`);
}

const config: ForgeConfig = {
  outDir: resolve(process.env.AIMUSE_FORGE_OUT_DIR || 'out'),
  packagerConfig: { asar: true, prune: false, executableName: 'AIMuse', extraResource: [resolve('native', 'dist', 'native')] },
  rebuildConfig: { onlyModules: [] },
  makers: [new MakerSquirrel({ name: 'aimuse', setupExe: 'AIMuse-Setup.exe' }), new MakerZIP({}, ['win32', 'darwin'])],
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform) => {
      if (platform !== 'win32' && platform !== 'darwin') throw new Error(`AIMuse package hardening is unsupported on ${platform}.`);
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
      await flipFuses(packagedElectronExecutable(buildPath, platform), { version: FuseVersion.V1, strictlyRequireAllFuses: true, [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableCookieEncryption]: true, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true, [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false, [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, [FuseV1Options.WasmTrapHandlers]: true });
    },
  },
  plugins: [new VitePlugin({ build: [{ entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' }, { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' }], renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }] })],
};
export default config;
