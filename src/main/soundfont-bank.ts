import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { SoundBankLoader, SpessaLog, type BasicSoundBank } from 'spessasynth_core';
import type { AIMuseProject, SoundFontInstrument, SoundFontPreset } from '@aimuse/core';
import { BUNDLED_SOUNDFONT } from '../common/soundfont-library';

export const MAX_SOUNDFONT_BYTES = 256 * 1024 * 1024;
// Library logging must not write unsolicited protocol output in a headless engine.
SpessaLog.setLogLevel(false, false, false);

export function bundledSoundFontPath(moduleDirectory = __dirname): string {
  // Works in both the main bundle and its Node worker, where Electron's app API
  // and process.resourcesPath are not necessarily available.
  return basename(resolve(moduleDirectory, '../..')) === 'app.asar'
    ? resolve(moduleDirectory, '../../../soundfonts', BUNDLED_SOUNDFONT.filename)
    : resolve(moduleDirectory, '../../build/soundfonts', BUNDLED_SOUNDFONT.filename);
}

export function parseSoundFont(bytes: Buffer): BasicSoundBank {
  if (bytes.length < 12 || bytes.length > MAX_SOUNDFONT_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'sfbk' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Expected a complete SF2 SoundFont, at most 256 MiB.');
  // Reject truncated, overflowing and deeply nested RIFF chunks before parsing.
  const checkChunks = (start: number, end: number, depth: number): void => {
    if (depth > 3) throw new Error('Invalid SoundFont chunk nesting.');
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) throw new Error('Truncated SoundFont chunk.');
      const size = bytes.readUInt32LE(offset + 4); const next = offset + 8 + size;
      if (next > end) throw new Error('SoundFont chunk exceeds its container.');
      if (bytes.toString('ascii', offset, offset + 4) === 'LIST') {
        if (size < 4) throw new Error('Invalid SoundFont list.');
        checkChunks(offset + 12, next, depth + 1);
      }
      offset = next + (size % 2);
    }
    if (offset !== end) throw new Error('Invalid SoundFont padding.');
  };
  checkChunks(12, bytes.length, 0);
  const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (!bank.presets.length || bank.presets.length > 16_512 || !bank.samples.length) throw new Error('SoundFont requires playable presets and samples.');
  return bank;
}

export function soundFontPresets(bank: BasicSoundBank): SoundFontPreset[] {
  return bank.presets.map((preset) => ({ bank: preset.isGMGSDrum ? 128 : preset.bankMSB, program: preset.program, name: preset.name.trim() || `Preset ${preset.program + 1}` })).sort((a, b) => a.bank - b.bank || a.program - b.program);
}

export async function loadSoundFont(project: AIMuseProject, settings: SoundFontInstrument): Promise<BasicSoundBank> {
  const asset = settings.source === 'asset' ? project.assets[settings.assetId!] : undefined;
  if (settings.source === 'asset' && asset?.kind !== 'soundfont') throw new Error('The selected SoundFont asset is missing.');
  const path = asset
    ? asset.storage === 'embedded' ? project.projectPath && resolve(project.projectPath, asset.relativePath ?? join('assets', asset.sha256)) : asset.externalPath
    : bundledSoundFontPath();
  if (!path) throw new Error('The selected SoundFont source is unavailable.');
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SOUNDFONT_BYTES) throw new Error('SoundFont file size is outside AIMuse limits.');
  const bytes = await readFile(path);
  const expected = asset?.sha256 ?? BUNDLED_SOUNDFONT.sha256;
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('SoundFont content changed. Reimport the bank before rendering.');
  return parseSoundFont(bytes);
}
