import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type AudioClip,
  type MediaAsset,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-clip-mutable', kind: 'agent', name: 'Clip Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-clip-mutable-reviewer', kind: 'agent', name: 'Clip Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Clip mutable integrity', createdAt: nowIso(), operations };
}

function midiClip(trackId: string, name = 'MIDI fixture'): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name, color: '#8b5cf6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' },
    loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function asset(): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'audio', name: 'Fixture.wav', mimeType: 'audio/wav', sha256: 'c'.repeat(64), byteLength: 96_000,
    storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
  };
}

function audioClip(trackId: string, assetId: string): AudioClip {
  return {
    ...entityBase('clip', AGENT), kind: 'audio', trackId, assetId, name: 'Audio fixture', color: '#14b8a6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers: [],
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo clip mutable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Clip mutable values');
  const midiTrack = base.tracks[base.trackOrder[0]];
  const audioTrack = createTrack('audio', 'Audio', '#14b8a6', AGENT);
  const media = asset();
  const midi = midiClip(midiTrack.id);
  const audio = audioClip(audioTrack.id, media.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: audioTrack },
    { kind: 'asset.add', asset: media },
    { kind: 'clip.add', clip: midi },
    { kind: 'clip.add', clip: audio },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, midiTrack, audioTrack, midi, audio };
}

describe('clip mutable declared-value integrity', () => {
  it('preserves order, attribution and semantic inverses across add, update and delete lifecycles', () => {
    let project = createProject('song', 'Clip mutable lifecycles');
    const midiTrack = project.tracks[project.trackOrder[0]];
    const audioTrack = createTrack('audio', 'Audio', '#14b8a6', AGENT);
    const media = asset();
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: audioTrack }, { kind: 'asset.add', asset: media },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const midi = midiClip(midiTrack.id);
    const audio = audioClip(audioTrack.id, media.id);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.add', clip: midi }, { kind: 'clip.add', clip: audio }]);

    const midiOrder = [...project.tracks[midiTrack.id].clipIds];
    const audioOrder = [...project.tracks[audioTrack.id].clipIds];
    const midiCreatedAt = project.clips[midi.id].createdAt;
    const audioCreatedAt = project.clips[audio.id].createdAt;
    project = commitAndVerifyInverse(project, [
      {
        kind: 'clip.update', clipId: midi.id, expectedRevision: project.clips[midi.id].revision,
        changes: {
          name: 'M'.repeat(200), color: 'c'.repeat(40), muted: true,
          fadeIn: { durationTicks: 12, curve: 'equal-power' }, fadeOut: { durationTicks: 24, curve: 's-curve' }, loopEnabled: true,
        },
      },
      ({
        kind: 'clip.update', clipId: audio.id, expectedRevision: project.clips[audio.id].revision,
        changes: {
          name: 'Reviewed audio', color: '', muted: true,
          fadeIn: { durationTicks: 36, curve: 's-curve' }, fadeOut: { durationTicks: 48, curve: 'equal-power' }, loopEnabled: true,
          stretchMode: 'repitch', reverse: true,
        },
      } as unknown as ProjectOperation),
    ], REVIEWER);
    expect(project.clips[midi.id]).toMatchObject({
      name: 'M'.repeat(200), color: 'c'.repeat(40), muted: true, loopEnabled: true,
      fadeIn: { durationTicks: 12, curve: 'equal-power' }, fadeOut: { durationTicks: 24, curve: 's-curve' },
      createdAt: midiCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.clips[audio.id]).toMatchObject({
      name: 'Reviewed audio', color: '', muted: true, loopEnabled: true, stretchMode: 'repitch', reverse: true,
      fadeIn: { durationTicks: 36, curve: 's-curve' }, fadeOut: { durationTicks: 48, curve: 'equal-power' },
      createdAt: audioCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.tracks[midiTrack.id].clipIds).toEqual(midiOrder);
    expect(project.tracks[audioTrack.id].clipIds).toEqual(audioOrder);

    project = commitAndVerifyInverse(project, [
      { kind: 'clip.delete', clipId: midi.id, expectedRevision: project.clips[midi.id].revision },
      { kind: 'clip.delete', clipId: audio.id, expectedRevision: project.clips[audio.id].revision },
    ], REVIEWER);
    expect(project.clips[midi.id]).toBeUndefined();
    expect(project.clips[audio.id]).toBeUndefined();
  });

  it('accepts exact literals and rejects malformed mutable values before mutation', () => {
    const { project, midiTrack, midi, audio } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<{ clipId: string; changes: Record<string, unknown>; message: RegExp }> = [
      { clipId: midi.id, changes: { name: '' }, message: /invalid text values/i },
      { clipId: midi.id, changes: { name: 'n'.repeat(201) }, message: /invalid text values/i },
      { clipId: midi.id, changes: { name: 42 }, message: /invalid text values/i },
      { clipId: midi.id, changes: { color: 'c'.repeat(41) }, message: /invalid text values/i },
      { clipId: midi.id, changes: { color: false }, message: /invalid text values/i },
      { clipId: midi.id, changes: { muted: 'yes' }, message: /invalid state flags/i },
      { clipId: midi.id, changes: { loopEnabled: 1 }, message: /invalid state flags/i },
      { clipId: midi.id, changes: { fadeIn: null }, message: /invalid fade values/i },
      { clipId: midi.id, changes: { fadeIn: { durationTicks: 0, curve: 'bezier' } }, message: /invalid fade values/i },
      { clipId: midi.id, changes: { fadeOut: { durationTicks: 0 } }, message: /invalid fade values/i },
      { clipId: audio.id, changes: { stretchMode: 'elastic' }, message: /invalid playback values/i },
      { clipId: audio.id, changes: { reverse: 'yes' }, message: /invalid playback values/i },
    ];

    for (const { clipId, changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.clips[clipId], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = {
        kind: 'clip.update', clipId, changes, expectedRevision: project.clips[clipId].revision,
      } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidAdd = { ...midiClip(midiTrack.id, ''), id: createId('clip') } as MidiClip;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: invalidAdd }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid text values/i);
    expect(project).toEqual(original);
  });
});
