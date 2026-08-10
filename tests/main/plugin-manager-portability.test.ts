import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPluginCandidates, pluginBinaryFor, standardPluginRoots } from '../../src/main/plugin-manager';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('plug-in manager platform layouts', () => {
  it('uses macOS system and user VST3/CLAP roots while retaining Windows roots', () => {
    expect(standardPluginRoots('darwin', '/Users/test', {})).toEqual([
      '/Library/Audio/Plug-Ins/VST3',
      '/Users/test/Library/Audio/Plug-Ins/VST3',
      '/Library/Audio/Plug-Ins/CLAP',
      '/Users/test/Library/Audio/Plug-Ins/CLAP',
    ]);
    expect(standardPluginRoots('win32', '/unused', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' })).toEqual([
      resolve('C:\\Program Files', 'Common Files', 'VST3'),
      resolve('C:\\Users\\test\\AppData\\Local', 'Programs', 'Common', 'VST3'),
      resolve('C:\\Program Files', 'Common Files', 'CLAP'),
      resolve('C:\\Users\\test\\AppData\\Local', 'Programs', 'Common', 'CLAP'),
    ]);
  });

  it('discovers and resolves macOS VST3 and CLAP bundle executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-layout-')); roots.push(root);
    const vst3 = join(root, 'Synth.vst3');
    const clap = join(root, 'Effect.clap');
    await mkdir(join(vst3, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(clap, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(vst3, 'Contents', 'MacOS', 'Synth'), 'vst3');
    await writeFile(join(clap, 'Contents', 'MacOS', 'Effect'), 'clap');
    await chmod(join(vst3, 'Contents', 'MacOS', 'Synth'), 0o755);
    await chmod(join(clap, 'Contents', 'MacOS', 'Effect'), 0o755);
    expect(await findPluginCandidates([root], 'darwin')).toEqual([clap, vst3].sort());
    expect(await pluginBinaryFor(vst3, 'darwin')).toBe(join(vst3, 'Contents', 'MacOS', 'Synth'));
    expect(await pluginBinaryFor(clap, 'darwin')).toBe(join(clap, 'Contents', 'MacOS', 'Effect'));
  });

  it('excludes Audio Unit bundles because AU is not an AIMuse format on either platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-layout-')); roots.push(root);
    const component = join(root, 'System Effect.component');
    await mkdir(join(component, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(component, 'Contents', 'MacOS', 'System Effect'), 'audio-unit');
    await chmod(join(component, 'Contents', 'MacOS', 'System Effect'), 0o755);
    expect(await findPluginCandidates([root], 'darwin')).toEqual([]);
  });

  it('rejects non-executable or ambiguous macOS bundle modules instead of hashing an arbitrary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-layout-')); roots.push(root);
    const nonExecutable = join(root, 'Unsafe.vst3');
    await mkdir(join(nonExecutable, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(nonExecutable, 'Contents', 'MacOS', 'Unsafe'), 'not-executable', { mode: 0o600 });
    await expect(pluginBinaryFor(nonExecutable, 'darwin')).rejects.toThrow('not executable');

    const ambiguous = join(root, 'Ambiguous.vst3');
    await mkdir(join(ambiguous, 'Contents', 'MacOS'), { recursive: true });
    for (const name of ['First', 'Second']) {
      await writeFile(join(ambiguous, 'Contents', 'MacOS', name), name, { mode: 0o755 });
      await chmod(join(ambiguous, 'Contents', 'MacOS', name), 0o755);
    }
    await expect(pluginBinaryFor(ambiguous, 'darwin')).rejects.toThrow('ambiguous macOS modules');
  });

  it('retains the Windows x86_64-win VST3 bundle convention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-layout-')); roots.push(root);
    const vst3 = join(root, 'Legacy.vst3');
    const module = join(vst3, 'Contents', 'x86_64-win', 'Legacy.vst3');
    await mkdir(join(vst3, 'Contents', 'x86_64-win'), { recursive: true });
    await writeFile(module, 'windows-vst3');
    expect(await pluginBinaryFor(vst3, 'win32')).toBe(module);
  });
});
