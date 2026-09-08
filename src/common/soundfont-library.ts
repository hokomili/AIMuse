import type { SoundFontInstrument, SoundFontPreset } from '@aimuse/core';
import presets from './soundfont-presets.json';

export const BUNDLED_SOUNDFONT = {
  id: 'generaluser-gs-2.0.3', name: 'GeneralUser GS 2.0.3', filename: 'GeneralUser-GS.sf2',
  sha256: '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe',
  byteLength: 32319396,
  presets: presets as SoundFontPreset[],
} as const;
export const DEFAULT_SOUNDFONT: SoundFontInstrument = { source: BUNDLED_SOUNDFONT.id, bank: 0, program: 0 };
export const SOUNDFONT_CONTROLLERS = [1, 7, 10, 11, 64] as const;
