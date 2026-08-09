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
  type AudioClip,
  type MediaAsset,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-clip', kind: 'agent', name: 'Clip Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-clip-reviewer', kind: 'agent', name: 'Clip Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Clip integrity', createdAt: nowIso(), operations };
}

function midiClip(trackId: string, name: string, startTick = 0, durationTicks = 1_920): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name, color: '#8b5cf6', startTick, durationTicks,
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

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo clip operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const project = createProject('song', 'Clip integrity');
  const midiTrack = project.tracks[project.trackOrder[0]];
  const audioTrack = createTrack('audio', 'Audio', '#14b8a6', AGENT);
  const media = asset();
  const midi = midiClip(midiTrack.id, 'MIDI fixture');
  const audio = audioClip(audioTrack.id, media.id);
  return {
    project: applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: audioTrack },
      { kind: 'asset.add', asset: media },
      { kind: 'clip.add', clip: midi },
      { kind: 'clip.add', clip: audio },
    ], AGENT), { authenticatedActor: AGENT }).project,
    midiTrack,
    audioTrack,
    midi,
    audio,
    media,
  };
}

describe('unlaned clip integrity', () => {
  it('keeps explicit clip ordering and declared edit lifecycles semantically invertible', () => {
    let project = createProject('song', 'Clip inverses');
    const sourceTrack = project.tracks[project.trackOrder[0]];
    const targetTrack = createTrack('midi', 'MIDI target', '#a78bfa', AGENT);
    const audioTrack = createTrack('audio', 'Audio target', '#14b8a6', AGENT);
    const media = asset();
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: targetTrack },
      { kind: 'track.add', track: audioTrack },
      { kind: 'asset.add', asset: media },
    ], AGENT), { authenticatedActor: AGENT }).project;

    const early = midiClip(sourceTrack.id, 'Early', 0);
    const later = midiClip(sourceTrack.id, 'Later', 960);
    project = commitAndVerifyInverse(project, [
      { kind: 'clip.add', clip: early },
      { kind: 'clip.add', clip: later, index: 0 },
    ]);
    expect(project.tracks[sourceTrack.id].clipIds).toEqual([later.id, early.id]);
    expect(project.clips[later.id].startTick).toBeGreaterThan(project.clips[early.id].startTick);

    const createdAt = project.clips[early.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.update', clipId: early.id,
      changes: { name: 'Reviewed clip', startTick: 120, durationTicks: 1_680, muted: true, gainDb: -3, fadeIn: { durationTicks: 60, curve: 'linear' }, loopEnabled: true, loopLengthTicks: 480 },
      expectedRevision: project.clips[early.id].revision,
    }], REVIEWER);
    expect(project.clips[early.id]).toMatchObject({ createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, startTick: 120, durationTicks: 1_680 });

    project = commitAndVerifyInverse(project, [{
      kind: 'clip.move', clipId: early.id, trackId: targetTrack.id, startTick: 480, index: 0, expectedRevision: project.clips[early.id].revision,
    }], REVIEWER);
    expect(project.tracks[sourceTrack.id].clipIds).toEqual([later.id]);
    expect(project.tracks[targetTrack.id].clipIds).toEqual([early.id]);
    expect(project.clips[early.id]).toMatchObject({ trackId: targetTrack.id, startTick: 480, createdBy: AGENT.id, updatedBy: REVIEWER.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'clip.trim', clipId: early.id, startTick: 600, durationTicks: 1_200, expectedRevision: project.clips[early.id].revision,
    }]);
    expect(project.clips[early.id]).toMatchObject({ startTick: 600, durationTicks: 1_200 });

    const right = midiClip(targetTrack.id, 'Right split');
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.split', clipId: early.id, tick: 1_200, rightClip: right, expectedRevision: project.clips[early.id].revision,
    }], REVIEWER);
    expect(project.clips[early.id]).toMatchObject({ startTick: 600, durationTicks: 600, createdBy: AGENT.id, updatedBy: REVIEWER.id });
    expect(project.clips[right.id]).toMatchObject({ startTick: 1_200, durationTicks: 600, createdBy: REVIEWER.id });
    expect(project.tracks[targetTrack.id].clipIds).toEqual([early.id, right.id]);

    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: right.id, expectedRevision: project.clips[right.id].revision }]);
    expect(project.clips[right.id]).toBeUndefined();
    expect(project.tracks[targetTrack.id].clipIds).toEqual([early.id]);

    const audio = audioClip(audioTrack.id, media.id);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.add', clip: audio }]);
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.trim', clipId: audio.id, startTick: 240, durationTicks: 960, sourceStartSample: 128, sourceDurationSamples: 4_096, expectedRevision: project.clips[audio.id].revision,
    }], REVIEWER);
    expect(project.clips[audio.id]).toMatchObject({ startTick: 240, durationTicks: 960, sourceStartSample: 128, sourceDurationSamples: 4_096, createdBy: AGENT.id, updatedBy: REVIEWER.id });
    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: audio.id, expectedRevision: project.clips[audio.id].revision }]);
    expect(project.clips[audio.id]).toBeUndefined();
    expect(project.tracks[audioTrack.id].clipIds).toEqual([]);
  });

  it('rejects malformed order, timing, source bounds, kind compatibility, and split shape', () => {
    const { project, midiTrack, audioTrack, midi, audio, media } = populatedProject();
    validateProjectIntegrity(project);

    const duplicate = structuredClone(project);
    duplicate.tracks[midiTrack.id].clipIds.push(midi.id);
    expect(() => validateProjectIntegrity(duplicate)).toThrow(/duplicate clip references/i);

    const missing = structuredClone(project);
    missing.tracks[midiTrack.id].clipIds.push('missing-clip');
    expect(() => validateProjectIntegrity(missing)).toThrow(/invalid clip reference/i);

    const orphan = structuredClone(project);
    orphan.tracks[midiTrack.id].clipIds = [];
    expect(() => validateProjectIntegrity(orphan)).toThrow(/clip .* orphaned/i);

    const incompatible = structuredClone(project);
    incompatible.tracks[midiTrack.id].clipIds = [];
    incompatible.tracks[audioTrack.id].clipIds.push(midi.id);
    incompatible.clips[midi.id].trackId = audioTrack.id;
    expect(() => validateProjectIntegrity(incompatible)).toThrow(/clip .* incompatible with track/i);

    const invalidTiming = structuredClone(project);
    invalidTiming.clips[midi.id].durationTicks = 0;
    expect(() => validateProjectIntegrity(invalidTiming)).toThrow(/invalid timing or gain/i);

    const invalidGain = structuredClone(project);
    invalidGain.clips[midi.id].gainDb = 25;
    expect(() => validateProjectIntegrity(invalidGain)).toThrow(/invalid timing or gain/i);

    const invalidFade = structuredClone(project);
    invalidFade.clips[midi.id].fadeIn.durationTicks = -1;
    expect(() => validateProjectIntegrity(invalidFade)).toThrow(/invalid fade or loop timing/i);

    const invalidLoop = structuredClone(project);
    invalidLoop.clips[midi.id].loopLengthTicks = 0;
    expect(() => validateProjectIntegrity(invalidLoop)).toThrow(/invalid fade or loop timing/i);

    const invalidSource = structuredClone(project);
    (invalidSource.clips[audio.id] as AudioClip).sourceStartSample = -1;
    expect(() => validateProjectIntegrity(invalidSource)).toThrow(/invalid source bounds/i);

    const invalidWarp = structuredClone(project);
    (invalidWarp.clips[audio.id] as AudioClip).warpMarkers = [{ ...entityBase('warp', AGENT), sourceSample: -1, projectTick: 0 }];
    expect(() => validateProjectIntegrity(invalidWarp)).toThrow(/invalid warp timing/i);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'clip.move', clipId: audio.id, trackId: midiTrack.id, startTick: 0, expectedRevision: project.clips[audio.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/target track is incompatible/i);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'clip.split', clipId: midi.id, tick: 960, rightClip: audioClip(audioTrack.id, media.id), expectedRevision: project.clips[midi.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/split clips must have the same kind/i);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'clip.update', clipId: midi.id, changes: { startTick: 1.5 }, expectedRevision: project.clips[midi.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid timing or gain/i);
  });
});
