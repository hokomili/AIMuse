import { useState } from 'react';
import type { AIMuseProject, Device, ProjectTransaction, SoundFontInstrument, SoundFontPreset } from '@aimuse/core';
import { BUNDLED_SOUNDFONT } from '../common/soundfont-library';
import { transaction } from './editor-helpers';

export function SoundFontControls({ project, device, onApply }: { project: AIMuseProject; device: Device; onApply(edit: ProjectTransaction): Promise<boolean> }) {
  const [query, setQuery] = useState('');
  const settings = device.soundfont;
  if (!settings) return <p>SoundFont settings are missing.</p>;
  const imported = Object.values(project.assets).filter((asset) => asset.kind === 'soundfont' && asset.soundfontPresets?.length);
  const presets = settings.source === 'asset' ? project.assets[settings.assetId!]?.soundfontPresets ?? [] : BUNDLED_SOUNDFONT.presets;
  const selected = presets.find((preset) => preset.bank === settings.bank && preset.program === settings.program);
  const choose = (next: SoundFontInstrument, preset: SoundFontPreset) => void onApply(transaction(project, 'Select SoundFont instrument', [{ kind: 'device.update', deviceId: device.id, expectedRevision: device.revision, changes: { soundfont: { ...next, bank: preset.bank, program: preset.program }, presetName: preset.name } }]));
  const visible = presets.filter((preset) => preset === selected || `${preset.name} ${preset.bank === 128 ? 'drums percussion kit' : ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="soundfont-controls">
    <label><span>Library</span><select aria-label="SoundFont library" value={settings.source === 'asset' ? settings.assetId : BUNDLED_SOUNDFONT.id} onChange={(event) => {
      const asset = imported.find((value) => value.id === event.target.value);
      const available = asset?.soundfontPresets ?? BUNDLED_SOUNDFONT.presets;
      choose(asset ? { ...settings, source: 'asset', assetId: asset.id } : { source: BUNDLED_SOUNDFONT.id, bank: 0, program: 0 }, available.find((preset) => preset.bank === 0 && preset.program === 0) ?? available[0]);
      setQuery('');
    }}><option value={BUNDLED_SOUNDFONT.id}>{BUNDLED_SOUNDFONT.name}</option>{imported.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
    <label><span>Find sound</span><input aria-label="Find SoundFont preset" placeholder="Piano, strings, drums…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <label><span>Preset</span><select aria-label="SoundFont preset" value={`${settings.bank}:${settings.program}`} onChange={(event) => {
      const preset = presets.find((value) => `${value.bank}:${value.program}` === event.target.value);
      if (preset) choose(settings, preset);
    }}>{!selected && <option value={`${settings.bank}:${settings.program}`}>Unavailable preset</option>}{visible.map((preset) => <option key={`${preset.bank}:${preset.program}`} value={`${preset.bank}:${preset.program}`}>{preset.bank === 128 ? 'Drums · ' : ''}{preset.name}{preset.bank > 0 && preset.bank !== 128 ? ` · bank ${preset.bank}` : ''}</option>)}</select></label>
    <small>Import an SF2 file from Media to add a library.{settings.bank === 128 ? ' Drum notes use General MIDI key mapping.' : ''}</small>
  </div>;
}
