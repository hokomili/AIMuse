import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ticksToSamples, type AIMuseProject, type AudioClip, type Id, type MidiClip } from '@aimuse/core';
import { atomicWriteFile } from './persistence';
import { decodeWav, encodeFloat32Wav } from './wav';

export interface ProjectRenderRequest {
  project: AIMuseProject;
  destination: string;
  startTick?: number;
  endTick?: number;
  trackIds?: Id[];
}

export interface ProjectRenderResult {
  destination: string;
  durationSamples: number;
  warnings: string[];
}

export async function renderProjectToWav({ project, destination, startTick = 0, endTick, trackIds }: ProjectRenderRequest): Promise<ProjectRenderResult> {
  const effectiveEnd = endTick ?? Math.max(project.settings.ppq * 4, ...Object.values(project.clips).map((clip) => clip.startTick + clip.durationTicks), ...Object.values(project.sfxDeliverables).map((value) => value.endTick));
  const startSample = ticksToSamples(project, startTick); const endSample = ticksToSamples(project, effectiveEnd); const frames = Math.max(1, endSample - startSample); const left = new Float32Array(frames); const right = new Float32Array(frames); const warnings: string[] = [];
  const allowed = trackIds ? new Set(trackIds) : undefined; const soloed = Object.values(project.tracks).filter((track) => track.solo).map((track) => track.id); const soloSet = new Set(soloed);
  for (const track of Object.values(project.tracks)) {
    if (allowed && !allowed.has(track.id)) continue; if (track.mute || (soloSet.size && !soloSet.has(track.id))) continue;
    const gain = 10 ** (track.gainDb / 20); const panL = Math.cos((track.pan + 1) * Math.PI / 4); const panR = Math.sin((track.pan + 1) * Math.PI / 4);
    for (const clipId of track.clipIds) {
      const clip = project.clips[clipId]; if (!clip || clip.muted) continue;
      if (clip.kind === 'midi') renderMidi(project, clip, startSample, left, right, gain * panL, gain * panR);
      else await renderAudio(project, clip, startSample, left, right, gain * panL, gain * panR, warnings);
    }
  }
  let peak = 1;
  for (let index = 0; index < frames; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  if (peak > 1) for (let index = 0; index < frames; index += 1) { left[index] /= peak; right[index] /= peak; }
  await atomicWriteFile(destination, encodeFloat32Wav([left, right], project.settings.sampleRate), (bytes) => { if (bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid rendered WAV.'); });
  return { destination, durationSamples: frames, warnings };
}

function renderMidi(project: AIMuseProject, clip: MidiClip, windowStartSample: number, left: Float32Array, right: Float32Array, gainL: number, gainR: number): void {
  const clipGain = 10 ** (clip.gainDb / 20) * 0.12;
  for (const note of Object.values(clip.notes)) {
    const noteStart = ticksToSamples(project, clip.startTick + note.startTick) - windowStartSample; const noteEnd = ticksToSamples(project, clip.startTick + note.startTick + note.durationTicks) - windowStartSample;
    const frequency = 440 * 2 ** ((note.pitch - 69) / 12); const start = Math.max(0, noteStart); const end = Math.min(left.length, noteEnd); const attack = Math.max(1, Math.round(project.settings.sampleRate * 0.008)); const release = Math.max(1, Math.round(project.settings.sampleRate * 0.06));
    for (let frame = start; frame < end; frame += 1) { const age = frame - noteStart; const remaining = noteEnd - frame; const envelope = Math.min(1, age / attack, remaining / release); const value = Math.sin(2 * Math.PI * frequency * age / project.settings.sampleRate) * note.velocity * note.probability * envelope * clipGain; left[frame] += value * gainL; right[frame] += value * gainR; }
  }
}

async function renderAudio(project: AIMuseProject, clip: AudioClip, windowStartSample: number, left: Float32Array, right: Float32Array, gainL: number, gainR: number, warnings: string[]): Promise<void> {
  const asset = project.assets[clip.assetId]; if (!asset) return;
  const path = asset.storage === 'linked' ? asset.externalPath : project.projectPath ? resolve(project.projectPath, asset.relativePath ?? join('assets', asset.sha256)) : asset.externalPath;
  if (!path) { warnings.push(`No source path for ${asset.name}.`); return; }
  try {
    const decoded = decodeWav(await readFile(path));
    if (decoded.sampleRate !== project.settings.sampleRate) { warnings.push(`${asset.name} needs resampling; skipped by the fallback renderer.`); return; }
    const timelineStart = ticksToSamples(project, clip.startTick) - windowStartSample; const frames = Math.min(clip.sourceDurationSamples, decoded.frames - clip.sourceStartSample); const clipGain = 10 ** (clip.gainDb / 20);
    for (let index = 0; index < frames; index += 1) { const destination = timelineStart + index; if (destination < 0 || destination >= left.length) continue; const sourceIndex = clip.reverse ? clip.sourceStartSample + frames - index - 1 : clip.sourceStartSample + index; const sourceL = decoded.data[0][sourceIndex] ?? 0; const sourceR = decoded.data[Math.min(1, decoded.channels - 1)][sourceIndex] ?? sourceL; left[destination] += sourceL * gainL * clipGain; right[destination] += sourceR * gainR * clipGain; }
  } catch (error) { warnings.push(`${asset.name}: ${error instanceof Error ? error.message : String(error)}`); }
}
