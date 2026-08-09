import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { macosHostFailures, macosVerificationContract } from '../../scripts/macos-preflight.mjs';
import { packagePlatformDecision } from '../../scripts/package-platform-preflight.mjs';

describe('macOS structural boundary', () => {
  it('keeps macOS verification source/native-test only and package/runtime work fail closed', async () => {
    expect(macosHostFailures({ platform: 'darwin', architecture: 'arm64', nodeVersion: 'v24.1.0' })).toEqual([]);
    expect(macosHostFailures({ platform: 'win32', architecture: 'x64', nodeVersion: 'v24.1.0' })).toContain('macOS verification requires darwin, received win32.');
    expect(macosVerificationContract()).toEqual({ runtimeBinariesBuilt: false, coreAudioClaimed: false, packageClaimed: false, signingClaimed: false, requiredTools: ['xcode-select', 'cmake', 'git'] });
    expect(packagePlatformDecision('win32').allowed).toBe(true);
    expect(packagePlatformDecision('darwin')).toMatchObject({ allowed: false, platform: 'darwin' });

    const cmake = await readFile(resolve('native/CMakeLists.txt'), 'utf8');
    const nativeBuild = await readFile(resolve('scripts/native-build.mjs'), 'utf8');
    const forge = await readFile(resolve('forge.config.ts'), 'utf8');
    const workflow = await readFile(resolve('.github/workflows/macos-structure.yml'), 'utf8');
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    expect(cmake).toContain('AIMUSE_BUILD_RUNTIME_BINARIES');
    expect(cmake).toContain('macOS runtime binaries are blocked until the CoreAudio backend');
    expect(nativeBuild).toContain("const buildRuntimeBinaries = process.platform === 'win32'");
    expect(forge).toContain("new MakerZIP({}, ['win32', 'darwin'])");
    expect(forge).toContain("resolve(buildPath, '..', '..', 'MacOS', 'AIMuse')");
    expect(workflow).toContain('npm run verify:macos');
    expect(workflow).not.toMatch(/npm run (?:package|make)/u);
    expect(packageJson.scripts['verify:macos']).toContain('macos:preflight');
    expect(packageJson.scripts.prepackage).toContain('package-platform-preflight.mjs');
  });
});
