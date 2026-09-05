import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { macosHostFailures, macosVerificationContract } from '../../scripts/macos-preflight.mjs';
import { packagePlatformDecision } from '../../scripts/package-platform-preflight.mjs';

describe('macOS structural boundary', () => {
  it('builds the shared CoreAudio/runtime and allows only a development package claim', async () => {
    expect(macosHostFailures({ platform: 'darwin', architecture: 'arm64', nodeVersion: 'v24.1.0' })).toEqual([]);
    expect(macosHostFailures({ platform: 'win32', architecture: 'x64', nodeVersion: 'v24.1.0' })).toContain('macOS verification requires darwin, received win32.');
    expect(macosVerificationContract()).toEqual({
      runtimeBinariesBuilt: true,
      coreAudioSharedRuntimeBuilt: true,
      coreAudioDeviceSmokeRequired: true,
      coreAudioExclusiveClaimed: false,
      developmentPackageAvailable: true,
      developerIdSigningClaimed: false,
      notarizationClaimed: false,
      requiredTools: ['xcode-select', 'cmake', 'git'],
    });
    expect(packagePlatformDecision('win32').allowed).toBe(true);
    expect(packagePlatformDecision('darwin')).toMatchObject({ allowed: true, platform: 'darwin', mode: 'development' });

    const cmake = await readFile(resolve('native/CMakeLists.txt'), 'utf8');
    const nativeBuild = await readFile(resolve('scripts/native-build.mjs'), 'utf8');
    const npmNode24 = await readFile(resolve('scripts/npm-node24.mjs'), 'utf8');
    const forge = await readFile(resolve('forge.config.ts'), 'utf8');
    const verifyPackage = await readFile(resolve('scripts/verify-package.mjs'), 'utf8');
    const icon = await readFile(resolve('build/icon.svg'), 'utf8');
    const workflow = await readFile(resolve('.github/workflows/macos-structure.yml'), 'utf8');
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    expect(cmake).toContain('AIMUSE_BUILD_RUNTIME_BINARIES');
    expect(cmake).toContain('target_compile_definitions(aimuse-playback PRIVATE AIMUSE_ENABLE_COREAUDIO=1)');
    expect(cmake).toContain('macOS runtime binaries require AIMUSE_ENABLE_COREAUDIO');
    expect(nativeBuild).toContain("process.platform === 'win32' || process.platform === 'darwin'");
    expect(nativeBuild).toContain("process.platform === 'darwin' && process.env.AIMUSE_ENABLE_COREAUDIO !== '0'");
    expect(nativeBuild).toContain('CMAKE_OSX_ARCHITECTURES');
    expect(nativeBuild).toContain('AIMUSE_NATIVE_BUILD_DIR');
    expect(nativeBuild).toContain('FETCHCONTENT_SOURCE_DIR_MINIAUDIO');
    expect(npmNode24).toContain("join(dirname(dirname(node24)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')");
    expect(npmNode24).toContain('dirname(npmCli)');
    expect(npmNode24).toContain("resolve('scripts', 'npm-shims')");
    expect(forge).toContain("new MakerZIP({}, ['win32', 'darwin'])");
    expect(forge).toContain("resolve(buildPath, '..', '..', 'MacOS', 'AIMuse')");
    expect(forge).toContain("icon: resolve('build', 'icon.icns')");
    expect(forge).toContain('AIMUSE_NATIVE_DIST_DIR');
    expect(forge).toContain('removeUnusedMacUsageDescriptions(buildPath)');
    expect(forge).toContain('afterCopyExtraResources:');
    expect(forge).toContain("resolve(buildPath, 'AIMuse.app', 'Contents', 'Resources', 'native')");
    expect(verifyPackage).toContain('AIMUSE_VERIFY_PACKAGE_ARCH');
    expect(icon).toContain('stroke="#ffffff"');
    expect(workflow).toContain('npm run verify:macos');
    expect(workflow).not.toMatch(/npm run (?:package|make)/u);
    expect(packageJson.scripts['verify:macos']).toContain('macos:preflight');
    expect(packageJson.scripts['macos:coreaudio-smoke']).toBe('node scripts/macos-coreaudio-smoke.mjs');
    expect(packageJson.scripts.prepackage).toContain('package-platform-preflight.mjs');
  });

  it('plans separate x64 and universal native outputs without claiming runtime evidence', () => {
    const plan = (architecture) => {
      const result = spawnSync(process.execPath, [resolve('scripts/native-build.mjs'), 'plan', `--arch=${architecture}`], { encoding: 'utf8', shell: false });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(plan('x64')).toMatchObject({ platform: 'darwin', requestedArchitecture: 'x64', cmakeArchitecture: 'x86_64' });
    expect(plan('universal')).toMatchObject({ platform: 'darwin', requestedArchitecture: 'universal', cmakeArchitecture: 'arm64;x86_64' });
  });
});
