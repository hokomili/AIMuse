import { MAX_SOUNDFONT_BYTES, parseSoundFont, soundFontPresets } from './soundfont-bank';
import { DEFAULT_SOUNDFONT } from '../common/soundfont-library';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parseFile } from 'music-metadata';
import { Midi } from '@tonejs/midi';
import {
  HUMAN_ACTOR, createId, createTrack, entityBase, nowIso,
  type AIMuseProject, type Actor, type AudioClip, type Id, type MediaAsset, type MidiClip, type ProjectOperation, type ProjectTransaction,
} from '@aimuse/core';
import { AuthorityManager } from './authority-manager';
import { atomicWriteFile, sha256File } from './persistence';
import { ProjectService } from './project-service';
import { decodeWav, type DecodedWav } from './wav';

const SUPPORTED = new Map<string, string>([
  ['.wav', 'audio/wav'], ['.flac', 'audio/flac'], ['.mp3', 'audio/mpeg'], ['.aac', 'audio/aac'], ['.m4a', 'audio/mp4'],
  ['.sf2', 'audio/sf2'], ['.ogg', 'audio/ogg'], ['.mid', 'audio/midi'], ['.midi', 'audio/midi'],
]);

export interface AudioAnalysis {
  version: 1; assetId: Id; sampleRate: number; channels: number; durationSamples: number;
  peakDbfs: number; rmsDbfs: number; integratedLufs: number; estimatedTempo?: number; estimatedKey?: string;
  transientSamples: number[]; waveform: Array<{ min: number; max: number; rms: number }>;
}

export interface ImportedMedia { asset: MediaAsset; managedPath: string; warnings: string[] }

export interface MediaImportFileEffect {
  index: number;
  outcome: 'pending' | 'running' | 'imported' | 'warning';
  sourceRead: 'not-started' | 'may-be-partial' | 'completed';
  cache: 'unchanged' | 'may-be-partial' | 'retained';
  projectTransaction: 'unchanged' | 'may-have-committed' | 'committed';
  assetSource: 'unchanged' | 'registered';
  assetId?: Id;
  warning?: string;
}

export type MediaImportObserver = (effect: MediaImportFileEffect) => void;

export interface MediaImportRuntime {
  makeCacheDirectory(path: string): Promise<void>;
  statSource(path: string): Promise<{ isFile(): boolean; size: number }>;
  hashSource(path: string): Promise<{ sha256: string; byteLength: number }>;
  copyToCache(source: string, destination: string): Promise<void>;
  readSource(path: string): Promise<Buffer>;
}

export interface MediaManagerOptions { importRuntime?: Partial<MediaImportRuntime> }

function db(value: number): number { return value > 0 ? 20 * Math.log10(value) : -120; }
function xml(value: string): string { return value.replace(/[&<>"']/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[match]!); }
function mono(decoded: DecodedWav): Float32Array { const output = new Float32Array(decoded.frames); for (let channel = 0; channel < decoded.channels; channel += 1) for (let index = 0; index < decoded.frames; index += 1) output[index] += decoded.data[channel][index] / decoded.channels; return output; }

export function analyzePcm(decoded: DecodedWav, assetId: Id): AudioAnalysis {
  const signal = mono(decoded); let peak = 0; let energy = 0;
  for (const sample of signal) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
  const rms = Math.sqrt(energy / Math.max(1, signal.length));
  const waveform: AudioAnalysis['waveform'] = []; const binCount = Math.min(1024, Math.max(64, Math.ceil(signal.length / 2048))); const binSize = Math.max(1, Math.ceil(signal.length / binCount));
  const envelope = new Float32Array(Math.ceil(signal.length / 512));
  for (let bin = 0; bin < binCount; bin += 1) { let minimum = 1; let maximum = -1; let sum = 0; const start = bin * binSize; const end = Math.min(signal.length, start + binSize); for (let index = start; index < end; index += 1) { const value = signal[index]; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); sum += value * value; } waveform.push({ min: end > start ? minimum : 0, max: end > start ? maximum : 0, rms: Math.sqrt(sum / Math.max(1, end - start)) }); }
  for (let bin = 0; bin < envelope.length; bin += 1) { let sum = 0; const start = bin * 512; const end = Math.min(signal.length, start + 512); for (let index = start; index < end; index += 1) sum += signal[index] * signal[index]; envelope[bin] = Math.sqrt(sum / Math.max(1, end - start)); }
  const transients: number[] = []; let previous = 0; let meanFlux = 0; const flux = new Float32Array(envelope.length);
  for (let index = 0; index < envelope.length; index += 1) { flux[index] = Math.max(0, envelope[index] - previous); previous = envelope[index]; meanFlux += flux[index]; }
  meanFlux /= Math.max(1, flux.length); for (let index = 2; index < flux.length - 2; index += 1) if (flux[index] > meanFlux * 3 && flux[index] >= flux[index - 1] && flux[index] >= flux[index + 1]) transients.push(index * 512);
  const envelopeRate = decoded.sampleRate / 512; let bestBpm: number | undefined; let bestScore = 0;
  if (signal.length >= decoded.sampleRate * 4) for (let bpm = 60; bpm <= 200; bpm += 1) { const lag = Math.round(envelopeRate * 60 / bpm); let score = 0; for (let index = lag; index < flux.length; index += 1) score += flux[index] * flux[index - lag]; if (score > bestScore) { bestScore = score; bestBpm = bpm; } }
  const pitchEnergy = new Array<number>(12).fill(0); const analysisFrames = Math.min(signal.length, decoded.sampleRate * 30); const stride = Math.max(1, Math.floor(analysisFrames / 12_000));
  for (let midi = 36; midi <= 83; midi += 1) { const frequency = 440 * 2 ** ((midi - 69) / 12); const omega = 2 * Math.PI * frequency / decoded.sampleRate; let real = 0; let imaginary = 0; for (let index = 0; index < analysisFrames; index += stride) { real += signal[index] * Math.cos(omega * index); imaginary -= signal[index] * Math.sin(omega * index); } pitchEnergy[midi % 12] += Math.hypot(real, imaginary); }
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]; const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]; const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']; let key: string | undefined; let keyScore = 0;
  for (let root = 0; root < 12; root += 1) for (const [profile, suffix] of [[major, 'major'], [minor, 'minor']] as const) { let score = 0; for (let note = 0; note < 12; note += 1) score += pitchEnergy[(note + root) % 12] * profile[note]; if (score > keyScore) { keyScore = score; key = `${names[root]} ${suffix}`; } }
  const integratedLufs = Math.max(-120, -0.691 + 10 * Math.log10(Math.max(1e-12, energy / Math.max(1, signal.length))));
  return { version: 1, assetId, sampleRate: decoded.sampleRate, channels: decoded.channels, durationSamples: decoded.frames, peakDbfs: db(peak), rmsDbfs: db(rms), integratedLufs, estimatedTempo: bestBpm, estimatedKey: key, transientSamples: transients.slice(0, 10_000), waveform };
}

function waveformSvg(name: string, waveform: AudioAnalysis['waveform']): string {
  const width = 1200; const height = 240; const step = width / Math.max(1, waveform.length); const upper = waveform.map((bin, index) => `${index ? 'L' : 'M'} ${(index * step).toFixed(2)} ${(height / 2 - bin.max * height * 0.44).toFixed(2)}`).join(' '); const lower = waveform.slice().reverse().map((bin, reverseIndex) => { const index = waveform.length - reverseIndex - 1; return `L ${(index * step).toFixed(2)} ${(height / 2 - bin.min * height * 0.44).toFixed(2)}`; }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xml(name)}</title><rect width="100%" height="100%" rx="18" fill="#11131a"/><path d="${upper} ${lower} Z" fill="#8b5cf6" opacity=".82"/><path d="M0 ${height / 2}H${width}" stroke="#fff" opacity=".12"/></svg>`;
}

function spectrogramSvg(name: string, decoded: DecodedWav): string {
  const signal = mono(decoded); const columns = 96; const rows = 48; const values = new Float32Array(columns * rows); let maximum = 1e-9; const window = 512;
  for (let column = 0; column < columns; column += 1) { const start = Math.floor(column / Math.max(1, columns - 1) * Math.max(0, signal.length - window)); for (let row = 0; row < rows; row += 1) { const bin = 1 + Math.floor((row / rows) ** 2 * 127); let real = 0; let imaginary = 0; for (let index = 0; index < window && start + index < signal.length; index += 1) { const value = signal[start + index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (window - 1))); const phase = 2 * Math.PI * bin * index / window; real += value * Math.cos(phase); imaginary -= value * Math.sin(phase); } const magnitude = Math.log1p(Math.hypot(real, imaginary)); values[column * rows + row] = magnitude; maximum = Math.max(maximum, magnitude); } }
  const cells: string[] = []; for (let column = 0; column < columns; column += 1) for (let row = 0; row < rows; row += 1) { const value = values[column * rows + row] / maximum; cells.push(`<rect x="${column}" y="${rows - row - 1}" width="1.05" height="1.05" fill="hsl(${270 - value * 110} 85% ${8 + value * 62}%)"/>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 ${columns} ${rows}" preserveAspectRatio="none"><title>${xml(name)}</title><rect width="100%" height="100%" fill="#090a0f"/>${cells.join('')}</svg>`;
}

function midiImportOperations(project: AIMuseProject, bytes: Uint8Array, filename: string, actor: Actor): ProjectOperation[] {
  const midi = new Midi(bytes);
  const scale = project.settings.ppq / Math.max(1, midi.header.ppq);
  const master = Object.values(project.tracks).find((track) => track.kind === 'master');
  const operations: ProjectOperation[] = [];
  const sourceTracks = midi.tracks.filter((track) => track.notes.length || track.pitchBends.length || Object.values(track.controlChanges).some((events) => events?.length));
  if (sourceTracks.length > 170) throw new Error('MIDI file has too many populated tracks for one validated import transaction.');
  sourceTracks.forEach((source, index) => {
    const track = createTrack('instrument', source.name.trim() || `${basename(filename, extname(filename))} ${index + 1}`, '#8b5cf6', actor);
    track.routing.outputTrackId = master?.id;
    const notes = Object.fromEntries(source.notes.map((sourceNote) => {
      const note = { ...entityBase('note', actor), startTick: Math.max(0, Math.round(sourceNote.ticks * scale)), durationTicks: Math.max(1, Math.round(sourceNote.durationTicks * scale)), pitch: sourceNote.midi, velocity: sourceNote.velocity, releaseVelocity: sourceNote.noteOffVelocity, channel: source.channel, probability: 1 };
      return [note.id, note];
    }));
    const controls = Object.fromEntries(Object.values(source.controlChanges).flatMap((events) => events ?? []).map((sourceEvent) => {
      const event = { ...entityBase('cc', actor), tick: Math.max(0, Math.round(sourceEvent.ticks * scale)), controller: sourceEvent.number, value: sourceEvent.value, channel: source.channel };
      return [event.id, event];
    }));
    const pitchBends = Object.fromEntries(source.pitchBends.map((sourceEvent) => {
      const event = { ...entityBase('bend', actor), tick: Math.max(0, Math.round(sourceEvent.ticks * scale)), value: Math.max(-1, Math.min(1, sourceEvent.value)), channel: source.channel };
      return [event.id, event];
    }));
    const endTick = Math.max(project.settings.ppq * 4, ...Object.values(notes).map((note) => note.startTick + note.durationTicks), ...Object.values(controls).map((event) => event.tick + 1), ...Object.values(pitchBends).map((event) => event.tick + 1));
    const clip: MidiClip = {
      ...entityBase('clip', actor), kind: 'midi', trackId: track.id, name: source.name.trim() || basename(filename, extname(filename)), color: track.color,
      startTick: 0, durationTicks: endTick, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false,
      notes, noteOrder: Object.keys(notes), controls, controlOrder: Object.keys(controls), pitchBends, pitchBendOrder: Object.keys(pitchBends),
    };
    operations.push({ kind: 'track.add', track, index: Math.max(0, project.trackOrder.length - 1) + index }, { kind: 'device.add', device: { ...entityBase('device', actor), trackId: track.id, format: 'builtin', builtinKind: 'soundfont', name: 'SoundFont', bypassed: false, degraded: false, latencySamples: 0, parameters: {}, soundfont: { ...DEFAULT_SOUNDFONT, bank: source.instrument.percussion ? 128 : 0, program: source.instrument.number } } }, { kind: 'clip.add', clip });
  });
  return operations;
}

export class MediaManager {
  private readonly importRuntime: MediaImportRuntime;

  constructor(private readonly root: string, private readonly projects: ProjectService, private readonly authority: AuthorityManager, options: MediaManagerOptions = {}) {
    this.importRuntime = {
      makeCacheDirectory: async (path) => { await mkdir(path, { recursive: true }); },
      statSource: (path) => stat(path),
      hashSource: (path) => sha256File(path),
      copyToCache: (source, destination) => copyFile(source, destination),
      readSource: (path) => readFile(path),
      ...options.importRuntime,
    };
  }

  async importPaths(projectId: Id, paths: string[], actor: Actor = HUMAN_ACTOR, authorityOverride = false, observer?: MediaImportObserver): Promise<{ imported: ImportedMedia[]; warnings: string[] }> {
    if (paths.length > 512) throw new Error('A media import is limited to 512 files.'); const project = this.projects.getProject(projectId); if (!project) throw new Error('Project is not open.');
    const imported: ImportedMedia[] = []; const warnings: string[] = []; await this.importRuntime.makeCacheDirectory(join(this.root, 'media'));
    for (const [index, requestedPath] of paths.entries()) {
      const effect: MediaImportFileEffect = { index, outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' };
      const report = () => { try { observer?.(structuredClone(effect)); } catch { /* Progress reporting must not change import semantics. */ } };
      effect.outcome = 'running'; report();
      try {
      const sourcePath = resolve(requestedPath); const extension = extname(sourcePath).toLowerCase(); const mimeType = SUPPORTED.get(extension); if (!mimeType) throw new Error(`Unsupported media type: ${extension || '(none)'}`);
      if (actor.kind === 'agent' && !authorityOverride) { const decision = await this.authority.file(sourcePath, 'read', true); if (!decision.allowed) throw new Error(decision.reason); }
      const info = await this.importRuntime.statSource(sourcePath); if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 ** 3) throw new Error('Media file size is outside AIMuse limits.');
      if (extension === '.sf2' && info.size > MAX_SOUNDFONT_BYTES) throw new Error('SoundFont exceeds the 256 MiB limit.');
      effect.sourceRead = 'may-be-partial'; report(); const hashed = await this.importRuntime.hashSource(sourcePath); effect.sourceRead = 'completed'; report();
      const managedPath = join(this.root, 'media', hashed.sha256); effect.cache = 'may-be-partial'; report(); await this.importRuntime.copyToCache(sourcePath, managedPath); effect.cache = 'retained'; report();
      const soundfontBytes = extension === '.sf2' ? await this.importRuntime.readSource(managedPath) : undefined;
      if (soundfontBytes && (soundfontBytes.length !== hashed.byteLength || createHash('sha256').update(soundfontBytes).digest('hex') !== hashed.sha256)) throw new Error('SoundFont changed while importing; import it again.');
      const presets = soundfontBytes ? soundFontPresets(parseSoundFont(soundfontBytes)) : undefined;
      const metadata = presets ? undefined : await parseFile(sourcePath, { duration: true, skipCovers: true }).catch(() => undefined); const timestamp = nowIso(); const base = { id: createId('asset'), revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actor.id, updatedBy: actor.id };
      const asset: MediaAsset = { ...base, kind: presets ? 'soundfont' : mimeType === 'audio/midi' ? 'midi' : 'audio', ...(presets ? { soundfontPresets: presets } : {}), name: basename(sourcePath), mimeType, sha256: hashed.sha256, byteLength: hashed.byteLength, storage: 'managed-cache', externalPath: managedPath, sampleRate: metadata?.format.sampleRate, channels: metadata?.format.numberOfChannels, durationSamples: metadata?.format.duration && metadata.format.sampleRate ? Math.round(metadata.format.duration * metadata.format.sampleRate) : undefined, source: 'import' };
      const operations: ProjectOperation[] = [{ kind: 'asset.add', asset }];
      if (asset.kind === 'midi') operations.push(...midiImportOperations(project, await this.importRuntime.readSource(sourcePath), asset.name, actor));
      effect.assetId = asset.id; effect.projectTransaction = 'may-have-committed'; report();
      const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('import'), projectId, actor, label: `Import ${asset.name}`, createdAt: timestamp, operations, checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); if (result.status !== 'committed') { if (result.status !== 'engine-error') effect.projectTransaction = 'unchanged'; throw new Error(result.message ?? 'Import transaction failed.'); }
      effect.projectTransaction = 'committed'; report(); this.projects.registerAssetSource(asset.id, managedPath); effect.assetSource = 'registered'; effect.outcome = 'imported'; report(); imported.push({ asset, managedPath, warnings: [] });
      } catch (error) { const warning = `${basename(requestedPath)}: ${error instanceof Error ? error.message : String(error)}`; effect.outcome = 'warning'; effect.warning = warning; warnings.push(warning); report(); }
    }
    return { imported, warnings };
  }

  async analyze(projectId: Id, assetId: Id, actor: Actor = HUMAN_ACTOR): Promise<{ analysis: AudioAnalysis; analysisAssetId: Id; waveformAssetId: Id; spectrogramAssetId: Id }> {
    const project = this.projects.getProject(projectId); const asset = project?.assets[assetId]; if (!project || !asset) throw new Error('Audio asset does not exist.'); const source = this.projects.getAssetSource(projectId, assetId); if (!source) throw new Error('Audio source is unavailable.');
    if (asset.mimeType !== 'audio/wav') throw new Error('Compressed-media analysis requires the native audio service; this build only analyzes WAV directly.');
    const decoded = decodeWav(await readFile(source)); const analysis = analyzePcm(decoded, assetId); const outputs = await Promise.all([this.writeManaged('analysis', `${asset.sha256}.analysis.json`, Buffer.from(`${JSON.stringify(analysis)}\n`), 'application/json', actor), this.writeManaged('analysis', `${asset.sha256}.waveform.svg`, Buffer.from(waveformSvg(asset.name, analysis.waveform)), 'image/svg+xml', actor), this.writeManaged('analysis', `${asset.sha256}.spectrogram.svg`, Buffer.from(spectrogramSvg(asset.name, decoded)), 'image/svg+xml', actor)]);
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('analysis'), projectId, actor, label: `Analyze ${asset.name}`, createdAt: nowIso(), operations: outputs.map(({ asset: output }) => ({ kind: 'asset.add' as const, asset: output })), checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); if (result.status !== 'committed') throw new Error(result.message ?? 'Analysis transaction failed.');
    for (const output of outputs) this.projects.registerAssetSource(output.asset.id, output.path); return { analysis, analysisAssetId: outputs[0].asset.id, waveformAssetId: outputs[1].asset.id, spectrogramAssetId: outputs[2].asset.id };
  }

  async createAudioClip(projectId: Id, assetId: Id, trackId: Id, startTick: number, actor: Actor = HUMAN_ACTOR): Promise<AudioClip> {
    const project = this.projects.getProject(projectId); const asset = project?.assets[assetId]; if (!project || !asset || asset.kind !== 'audio') throw new Error('Audio asset does not exist.'); const durationSamples = asset.durationSamples ?? project.settings.sampleRate; const durationTicks = Math.max(1, Math.round(durationSamples / project.settings.sampleRate * project.settings.ppq * 2));
    const clip: AudioClip = { ...entityBase('clip', actor), kind: 'audio', trackId, assetId, name: asset.name.replace(/\.[^.]+$/, ''), color: '#06b6d4', startTick: Math.max(0, Math.round(startTick)), durationTicks, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false, sourceStartSample: 0, sourceDurationSamples: durationSamples, transposeSemitones: 0, stretchMode: 'repitch', reverse: false, warpMarkers: [] };
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('place-media'), projectId, actor, label: `Place ${clip.name}`, createdAt: nowIso(), operations: [{ kind: 'clip.add', clip }], checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); if (result.status !== 'committed') throw new Error(result.message ?? 'Clip could not be placed.'); return clip;
  }

  private async writeManaged(kind: 'analysis' | 'audition', name: string, data: Buffer, mimeType: string, actor: Actor): Promise<{ asset: MediaAsset; path: string }> { const sha256 = createHash('sha256').update(data).digest('hex'); const path = join(this.root, kind, sha256); await atomicWriteFile(path, data); const asset: MediaAsset = { ...entityBase('asset', actor), kind, name, mimeType, sha256, byteLength: data.byteLength, storage: 'managed-cache', externalPath: path, source: 'system' }; return { asset, path }; }
}
