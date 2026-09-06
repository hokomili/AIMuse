import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ticksToSamples, samplesToTicks, type AIMuseProject, type AudioClip, type Clip, type Device, type Fade, type Id, type MidiClip, type Track } from '@aimuse/core';
import { RENDERED_BUILTINS } from '../common/render-capabilities';
import { atomicWriteFile } from './persistence';
import { UnsupportedAudioRenderError } from './audio-render-error';
import { decodeWav, encodeFloat32Wav } from './wav';
import { gainFromDb, lowPass, parameter, processDevice, sampleInterpolator, type Stereo } from './render-dsp';

export const RENDER_CACHE_VERSION = 'audio-contract-v2';

export interface ProjectRenderRequest {
  project: AIMuseProject;
  destination: string;
  startTick?: number;
  endTick?: number;
  trackIds?: Id[];
  /** A stem taps its selected track before downstream buses and master. */
  stem?: boolean;
  /** Master export normalizes first, then applies the master fader. */
  skipMasterFader?: boolean;
}
export interface ProjectRenderResult { destination: string; durationSamples: number; warnings: string[] }

function unsupported(subject: string, feature: string): never {
  throw new UnsupportedAudioRenderError(`${subject}: ${feature} is not supported by audio rendering. Bypass/remove this processing or render it externally and import WAV. See aimuse_help topic rendering.`);
}
const parameterRanges: Record<string, Record<string, [number, number]>> = {
  'subtractive-synth': { cutoff: [20, 20_000], resonance: [0, 1], attack: [0, 5], release: [0, 10] },
  utility: { gain: [-48, 24], width: [0, 2] },
  compressor: { threshold: [-60, 0], ratio: [1, 20], attack: [0.0001, 1], release: [0.01, 3] },
  delay: { time: [0.001, 2], feedback: [0, 0.98], mix: [0, 1] }, analyzer: {},
};
function validateDevice(device: Device): void {
  if (device.bypassed) return;
  if (device.format !== 'builtin' || !RENDERED_BUILTINS.some((kind) => kind === device.builtinKind)) unsupported(device.name, device.builtinKind ?? device.format);
  if (device.latencySamples || device.stateAssetId || device.degraded) unsupported(device.name, 'latency compensation, opaque state or degraded device');
  for (const [id, value] of Object.entries(device.parameters)) {
    const range = parameterRanges[device.builtinKind!]?.[id];
    if (!range || !Number.isFinite(value.value) || value.value < range[0] || value.value > range[1]) unsupported(device.name, `parameter ${id}=${value.value}`);
  }
}
export function applyTrackFader(data: Stereo, track: Track): void {
  // Stereo balance: unity at centre; silence the opposite channel at each edge.
  const gain = track.mute ? 0 : gainFromDb(track.gainDb);
  const left = gain * (track.pan > 0 ? Math.cos(track.pan * Math.PI / 2) : 1);
  const right = gain * (track.pan < 0 ? Math.cos(track.pan * Math.PI / 2) : 1);
  for (let i = 0; i < data[0].length; i += 1) { data[0][i] *= left; data[1][i] *= right; }
}

export async function renderProjectToWav({ project, destination, startTick = 0, endTick, trackIds, stem = false, skipMasterFader = false }: ProjectRenderRequest): Promise<ProjectRenderResult> {
  const effectiveEnd = endTick ?? Math.max(project.settings.ppq * 4, ...Object.values(project.clips).map((clip) => clip.startTick + clip.durationTicks), ...Object.values(project.sfxDeliverables).map((value) => value.endTick));
  if (!Number.isFinite(startTick) || !Number.isFinite(effectiveEnd) || startTick < 0 || effectiveEnd <= startTick) throw new Error('Audio render requires a positive tick range.');
  // Render preroll from the project origin so envelopes/delay have the same state in every range.
  const startSample = ticksToSamples(project, startTick); const endSample = ticksToSamples(project, effectiveEnd);
  if (!Number.isSafeInteger(endSample) || endSample > project.settings.sampleRate * 1800) throw new Error('Audio rendering currently supports up to 30 minutes from the project origin.');
  const frames = Math.max(1, endSample); const empty = (): Stereo => [new Float32Array(frames), new Float32Array(frames)]; const warnings = new Set<string>();
  const tracks = Object.values(project.tracks).filter((track) => track.kind !== 'folder'); const master = tracks.find((track) => track.kind === 'master');
  if (!master) throw new Error('Audio render requires a master track.');
  const inputs = new Map<Id, Track[]>();
  const pathToMaster = (track: Track): Track[] => {
    const path: Track[] = []; const seen = new Set<Id>(); let current = track;
    while (true) {
      if (seen.has(current.id)) throw new Error(`Cyclic output routing at ${current.name}.`); seen.add(current.id); path.push(current);
      if (current.id === master.id) return path;
      const next = project.tracks[current.routing.outputTrackId ?? master.id];
      if (!next || !['aux', 'master'].includes(next.kind)) throw new Error(`${current.name}: output must route to an aux or master track.`);
      current = next;
    }
  };
  for (const track of tracks) { pathToMaster(track); if (track.id !== master.id) { const output = track.routing.outputTrackId ?? master.id; inputs.set(output, [...(inputs.get(output) ?? []), track]); } }
  const selected = trackIds ? new Set(trackIds) : undefined;
  for (const id of selected ?? []) if (!project.tracks[id] || project.tracks[id].kind === 'folder') throw new Error(`Unknown or non-audio render track: ${id}.`);
  if (stem && trackIds?.length !== 1) throw new Error('A stem render requires exactly one track.');
  const anySolo = tracks.some((track) => track.solo);
  const eligible = (track: Track): boolean => { const path = pathToMaster(track); return (!selected || path.some((item) => selected.has(item.id))) && (!anySolo || path.some((item) => item.solo)); };
  const renderTrack = async (track: Track): Promise<{ data: Stereo; active: boolean }> => {
    const data = empty(); if (track.mute) return { data, active: false };
    let active = false;
    for (const input of inputs.get(track.id) ?? []) { const rendered = await renderTrack(input); active ||= rendered.active; for (let i = 0; i < frames; i += 1) { data[0][i] += rendered.data[0][i]; data[1][i] += rendered.data[1][i]; } }
    const clips = eligible(track) ? track.clipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip && !clip.muted && clip.startTick < effectiveEnd)) : [];
    active ||= clips.length > 0;
    if (!active) return { data, active };
    if (Object.values(project.sends).some((send) => send.enabled && send.sourceTrackId === track.id)) unsupported(track.name, 'send routing');
    if (Object.values(project.sidechains).some((sidechain) => sidechain.enabled && (sidechain.sourceTrackId === track.id || track.deviceIds.includes(sidechain.destinationDeviceId)))) unsupported(track.name, 'sidechain routing');
    if (Object.values(project.automationLanes).some((lane) => lane.trackId === track.id && Object.keys(lane.points).length)) unsupported(track.name, 'automation');
    if (Object.values(project.compSegments).some((segment) => segment.trackId === track.id) || clips.some((clip) => clip.takeLaneId)) unsupported(track.name, 'take-lane comping');
    const devices = track.deviceIds.map((id) => project.devices[id]); for (const device of devices) { if (!device) throw new Error(`${track.name}: missing device.`); validateDevice(device); }
    const activeDevices = devices.filter((device) => !device.bypassed); const synths = activeDevices.filter((device) => device.builtinKind === 'subtractive-synth');
    if (synths.length > 1 || (synths.length && activeDevices[0] !== synths[0])) unsupported(track.name, 'multiple or post-effect instruments');
    for (const clip of clips) {
      if (clip.loopEnabled && !clip.loopLengthTicks) throw new Error(`${clip.name}: enabled clip looping requires loopLengthTicks.`);
      if (clip.kind === 'midi') { if (!synths.length) warnings.add(`${track.name}: MIDI uses the sine guide voice; add Muse Synth for its envelope and filter controls.`); renderMidi(project, clip, data, synths[0]); }
      else { if (synths.length) unsupported(track.name, 'audio clips through a synth instrument'); await renderAudio(project, clip, data, warnings); }
    }
    for (const device of activeDevices) processDevice(data, device, project.settings.sampleRate);
    if (!(track.id === master.id && skipMasterFader)) applyTrackFader(data, track);
    return { data, active };
  };
  const rendered = await renderTrack(stem ? project.tracks[trackIds![0]] : master);
  let data = rendered.data.map((channel) => channel.slice(startSample, Math.max(startSample + 1, endSample)));
  if (project.settings.channelLayout === 'mono') data = [data[0].map((sample, index) => (sample + data[1][index]) * 0.5)];
  if (data.some((channel) => channel.some((sample) => !Number.isFinite(sample)))) throw new Error('Audio rendering produced non-finite samples.');
  await atomicWriteFile(destination, encodeFloat32Wav(data, project.settings.sampleRate, false));
  return { destination, durationSamples: data[0].length, warnings: [...warnings] };
}

function fadeValue(fade: Fade, amount: number): number { const x = Math.max(0, Math.min(1, amount)); return fade.curve === 'equal-power' ? Math.sin(x * Math.PI / 2) : fade.curve === 's-curve' ? x * x * (3 - 2 * x) : x; }
function clipEnvelope(project: AIMuseProject, clip: Clip): (frame: number) => number {
  const start = ticksToSamples(project, clip.startTick); const end = ticksToSamples(project, clip.startTick + clip.durationTicks);
  const attack = ticksToSamples(project, clip.startTick + clip.fadeIn.durationTicks) - start;
  const release = end - ticksToSamples(project, clip.startTick + Math.max(0, clip.durationTicks - clip.fadeOut.durationTicks));
  return (frame) => (attack ? fadeValue(clip.fadeIn, (frame - start) / attack) : 1) * (release ? fadeValue(clip.fadeOut, (end - 1 - frame) / release) : 1);
}
function* repetitions(clip: Clip, endTick: number): Generator<number> { const step = clip.loopEnabled ? clip.loopLengthTicks! : clip.durationTicks; for (let offset = 0; offset < Math.min(clip.durationTicks, endTick - clip.startTick); offset += step) yield offset; }
function renderMidi(project: AIMuseProject, clip: MidiClip, data: Stereo, synth?: Device): void {
  const fs = project.settings.sampleRate; const clipEnd = ticksToSamples(project, clip.startTick + clip.durationTicks); const fade = clipEnvelope(project, clip); const gain = gainFromDb(clip.gainDb) * 0.12;
  const controls = Object.values(clip.controls).sort((a, b) => a.tick - b.tick); const bends = Object.values(clip.pitchBends).sort((a, b) => a.tick - b.tick);
  if (controls.some((event) => ![7, 11].includes(event.controller))) unsupported(clip.name, 'MIDI controllers other than CC7/CC11');
  for (const note of Object.values(clip.notes)) if (note.probability > 0 && note.probability < 1) unsupported(clip.name, 'fractional note probability');
  for (const offset of repetitions(clip, samplesToTicks(project, data[0].length))) for (const note of Object.values(clip.notes)) {
    if (!note.probability || !note.velocity || (clip.loopEnabled && note.startTick >= clip.loopLengthTicks!)) continue;
    const baseTick = clip.startTick + offset; const noteStart = ticksToSamples(project, baseTick + note.startTick);
    const cycleEndTick = baseTick + (clip.loopEnabled ? clip.loopLengthTicks! : clip.durationTicks);
    const noteEnd = Math.min(clipEnd, ticksToSamples(project, Math.min(cycleEndTick, baseTick + note.startTick + note.durationTicks)));
    const attack = Math.max(1, fs * (synth ? parameter(synth, 'attack', 0.01) : 0.008)); const release = Math.max(1, fs * (synth ? parameter(synth, 'release', 0.4) : 0.06));
    const end = Math.min(data[0].length, clipEnd, ticksToSamples(project, cycleEndTick), noteEnd + (synth ? Math.ceil(release) : 0));
    const filter = synth ? lowPass(fs, parameter(synth, 'cutoff', 8000), 0.5 + parameter(synth, 'resonance', 0.15) * 9.5) : (sample: number) => sample;
    const events = [...controls.filter((event) => event.channel === note.channel).map((event) => ({ frame: ticksToSamples(project, baseTick + event.tick), kind: event.controller, value: event.value })), ...bends.filter((event) => event.channel === note.channel).map((event) => ({ frame: ticksToSamples(project, baseTick + event.tick), kind: -1, value: event.value }))].sort((a, b) => a.frame - b.frame);
    let eventIndex = 0; let volume = 1; let expression = 1; let bend = 0; let phase = 0;
    for (let frame = noteStart; frame < end; frame += 1) {
      while (eventIndex < events.length && events[eventIndex].frame <= frame) { const event = events[eventIndex++]; if (event.kind === 7) volume = event.value; else if (event.kind === 11) expression = event.value; else bend = event.value; }
      const held = Math.min(1, (frame - noteStart) / attack);
      const envelope = synth ? frame < noteEnd ? held : Math.min(1, (noteEnd - noteStart) / attack) * Math.max(0, 1 - (frame - noteEnd) / release) : Math.min(held, (noteEnd - frame) / release);
      const sample = filter(Math.sin(phase) * envelope) * note.velocity * volume * expression * gain * fade(frame);
      phase = (phase + 2 * Math.PI * 440 * 2 ** ((note.pitch - 69 + bend * 2) / 12) / fs) % (2 * Math.PI);
      data[0][frame] += sample; data[1][frame] += sample;
    }
  }
}
async function renderAudio(project: AIMuseProject, clip: AudioClip, data: Stereo, warnings: Set<string>): Promise<void> {
  if (clip.warpMarkers.length || (clip.stretchMode === 'stretch' && clip.transposeSemitones !== 0)) unsupported(clip.name, 'time stretching or warp markers');
  const asset = project.assets[clip.assetId]; if (!asset) throw new Error(`${clip.name}: source asset is missing.`);
  const path = asset.storage === 'linked' ? asset.externalPath : project.projectPath ? resolve(project.projectPath, asset.relativePath ?? join('assets', asset.sha256)) : asset.externalPath;
  if (!path) throw new Error(`${asset.name}: source path is missing.`);
  const decoded = await readFile(path).then(decodeWav).catch((error: unknown) => { throw new Error(`${asset.name}: ${error instanceof Error ? error.message : String(error)}`); });
  if (decoded.channels > 2 || decoded.sampleRate < 8000 || decoded.sampleRate > 192000) throw new Error(`${asset.name}: rendering supports mono/stereo WAV at 8–192 kHz.`);
  if (clip.sourceStartSample + clip.sourceDurationSamples > decoded.frames) throw new Error(`${clip.name}: source range exceeds the WAV's ${decoded.frames} frames.`);
  if (decoded.data.some((channel) => channel.some((sample) => !Number.isFinite(sample)))) throw new Error(`${asset.name}: WAV contains non-finite samples.`);
  if (decoded.sampleRate !== project.settings.sampleRate) warnings.add(`${asset.name}: resampled ${decoded.sampleRate} Hz to ${project.settings.sampleRate} Hz with windowed-sinc interpolation.`);
  const naturalFrames = clip.sourceDurationSamples * project.settings.sampleRate / decoded.sampleRate;
  const timelineFrames = ticksToSamples(project, clip.startTick + (clip.loopEnabled ? clip.loopLengthTicks! : clip.durationTicks)) - ticksToSamples(project, clip.startTick);
  const tickTolerance = ticksToSamples(project, clip.startTick + 1) - ticksToSamples(project, clip.startTick) + 1;
  if (clip.stretchMode === 'stretch' && timelineFrames > naturalFrames + tickTolerance) unsupported(clip.name, 'time stretching beyond the natural source duration');
  const step = decoded.sampleRate / project.settings.sampleRate * 2 ** (clip.transposeSemitones / 12); const interpolate = sampleInterpolator(step);
  const fade = clipEnvelope(project, clip); const gain = gainFromDb(clip.gainDb); const sourceEnd = clip.sourceStartSample + clip.sourceDurationSamples;
  const clipEnd = Math.min(data[0].length, ticksToSamples(project, clip.startTick + clip.durationTicks));
  for (const offset of repetitions(clip, samplesToTicks(project, data[0].length))) {
    const start = ticksToSamples(project, clip.startTick + offset); const end = Math.min(clipEnd, ticksToSamples(project, clip.startTick + offset + (clip.loopEnabled ? clip.loopLengthTicks! : clip.durationTicks)));
    for (let frame = start; frame < end; frame += 1) { const age = (frame - start) * step; if (age >= clip.sourceDurationSamples) break; const position = clip.reverse ? sourceEnd - 1 - age : clip.sourceStartSample + age; const level = gain * fade(frame); for (let channel = 0; channel < 2; channel += 1) data[channel][frame] += interpolate(decoded.data[Math.min(channel, decoded.channels - 1)], position, clip.sourceStartSample, sourceEnd) * level; }
  }
}
