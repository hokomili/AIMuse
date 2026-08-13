import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  validateTransaction,
  type Actor,
  type AIMuseProject,
  type AudioClip,
  type MediaAsset,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
  type Track,
  type WarpMarker,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-clip-numeric', kind: 'agent', name: 'Clip Numeric Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-clip-numeric', kind: 'human', name: 'Clip Numeric Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Clip numeric integrity', createdAt: nowIso(), operations };
}

function asset(): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'audio', name: 'Numeric fixture.wav', mimeType: 'audio/wav', sha256: 'd'.repeat(64), byteLength: 96_000,
    storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
  };
}

function marker(): WarpMarker {
  return { ...entityBase('warp', AGENT), sourceSample: 1_024, projectTick: 240 };
}

function audioClip(trackId: string, assetId: string, overrides: Record<string, unknown> = {}): AudioClip {
  return {
    ...entityBase('clip', AGENT), kind: 'audio', trackId, assetId, name: 'Audio numeric clip', color: '#14b8a6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers: [marker()], ...overrides,
  } as AudioClip;
}

function midiClip(trackId: string, overrides: Record<string, unknown> = {}): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name: 'MIDI numeric clip', color: '#8b5cf6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [], ...overrides,
  } as MidiClip;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  validateProjectIntegrity(committed.project);
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo clip numeric operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

function populatedProject(): {
  project: AIMuseProject;
  midiTrack: Track;
  midiTarget: Track;
  audioTrack: Track;
  audioTarget: Track;
  media: MediaAsset;
  midi: MidiClip;
  audio: AudioClip;
} {
  const base = createProject('song', 'Clip numeric declared values', AGENT);
  const midiTrack = base.tracks[base.trackOrder.find((id) => ['instrument', 'midi'].includes(base.tracks[id].kind))!];
  const midiTarget = createTrack('midi', 'MIDI target', '#a78bfa', AGENT);
  const audioTrack = createTrack('audio', 'Audio source', '#14b8a6', AGENT);
  const audioTarget = createTrack('audio', 'Audio target', '#06b6d4', AGENT);
  const media = asset();
  const midi = midiClip(midiTrack.id);
  const audio = audioClip(audioTrack.id, media.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: midiTarget }, { kind: 'track.add', track: audioTrack }, { kind: 'track.add', track: audioTarget },
    { kind: 'asset.add', asset: media }, { kind: 'clip.add', clip: midi }, { kind: 'clip.add', clip: audio },
  ]), { authenticatedActor: AGENT }).project;
  return { project, midiTrack, midiTarget, audioTrack, audioTarget, media, midi, audio };
}

describe('shared clip-base numeric declared-value integrity', () => {
  it('preserves exact independent boundaries, order, attribution and semantic inverses', () => {
    const base = createProject('song', 'Clip numeric boundaries', AGENT);
    const midiTrack = base.tracks[base.trackOrder.find((id) => ['instrument', 'midi'].includes(base.tracks[id].kind))!];
    const audioTrack = createTrack('audio', 'Boundary audio', '#14b8a6', AGENT);
    const audioTarget = createTrack('audio', 'Boundary target', '#06b6d4', AGENT);
    const media = asset();
    const prepared = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'track.add', track: audioTrack }, { kind: 'track.add', track: audioTarget }, { kind: 'asset.add', asset: media },
    ]), { authenticatedActor: AGENT }).project;
    const audioBoundary = audioClip(audioTrack.id, media.id, {
      name: 'Audio lower boundary', startTick: 0, durationTicks: 1, gainDb: 24,
      fadeIn: { durationTicks: Number.MAX_SAFE_INTEGER, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 's-curve' },
      loopEnabled: false, loopLengthTicks: Number.MAX_SAFE_INTEGER,
    });
    const midiBoundary = midiClip(midiTrack.id, {
      name: 'MIDI upper boundary', startTick: Number.MAX_SAFE_INTEGER, durationTicks: Number.MAX_SAFE_INTEGER, gainDb: -120,
      fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: Number.MAX_SAFE_INTEGER, curve: 'equal-power' },
      loopEnabled: true, loopLengthTicks: 1,
    });
    const working = audioClip(audioTrack.id, media.id, { name: 'Working numeric clip' });

    let project = commitAndVerifyInverse(prepared, [
      { kind: 'clip.add', clip: audioBoundary }, { kind: 'clip.add', clip: working }, { kind: 'clip.add', clip: midiBoundary },
    ]);
    expect(project.tracks[audioTrack.id].clipIds).toEqual([audioBoundary.id, working.id]);
    expect(project.clips[audioBoundary.id]).toMatchObject({
      startTick: 0, durationTicks: 1, gainDb: 24, fadeIn: { durationTicks: Number.MAX_SAFE_INTEGER }, fadeOut: { durationTicks: 0 },
      loopEnabled: false, loopLengthTicks: Number.MAX_SAFE_INTEGER, createdBy: AGENT.id, updatedBy: AGENT.id,
    });
    expect(project.clips[midiBoundary.id]).toMatchObject({
      startTick: Number.MAX_SAFE_INTEGER, durationTicks: Number.MAX_SAFE_INTEGER, gainDb: -120,
      fadeIn: { durationTicks: 0 }, fadeOut: { durationTicks: Number.MAX_SAFE_INTEGER }, loopLengthTicks: 1,
    });

    project = commitAndVerifyInverse(project, [{
      kind: 'clip.update', clipId: working.id, changes: {
        gainDb: -120, fadeIn: { durationTicks: Number.MAX_SAFE_INTEGER, curve: 'linear' },
        fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: true, loopLengthTicks: 1,
      },
    } as unknown as ProjectOperation], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.move', clipId: working.id, trackId: audioTarget.id, startTick: 240 }], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.trim', clipId: working.id, startTick: 120, durationTicks: 960 }], REVIEWER);
    const right = audioClip(audioTarget.id, media.id, { name: 'Right numeric split', gainDb: 24, loopLengthTicks: Number.MAX_SAFE_INTEGER });
    project = commitAndVerifyInverse(project, [{ kind: 'clip.split', clipId: working.id, tick: 600, rightClip: right }], REVIEWER);
    expect(project.tracks[audioTarget.id].clipIds).toEqual([working.id, right.id]);
    expect(project.clips[right.id]).toMatchObject({ startTick: 600, durationTicks: 480, gainDb: 24, loopLengthTicks: Number.MAX_SAFE_INTEGER, createdBy: REVIEWER.id });
    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: right.id }], REVIEWER);
    expect(project.clips[right.id]).toBeUndefined();
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects malformed stored, incoming, replacement, operation, split, existing-target and cleanup values with established precedence', () => {
    const { project, midiTrack, midiTarget, audioTrack, audioTarget, media, midi, audio } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp; operationMessage?: RegExp }> = [
      { changes: { startTick: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid timing or gain/i },
      { changes: { startTick: -1 }, message: /invalid timing or gain/i, operationMessage: /clip start is outside/i },
      { changes: { startTick: 0.5 }, message: /invalid timing or gain/i },
      { changes: { startTick: Number.NaN }, message: /invalid timing or gain/i, operationMessage: /clip start is outside/i },
      { changes: { startTick: Number.POSITIVE_INFINITY }, message: /invalid timing or gain/i, operationMessage: /clip start is outside/i },
      { changes: { startTick: 'tick' }, message: /invalid timing or gain/i, operationMessage: /clip start is outside/i },
      { changes: { durationTicks: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid timing or gain/i },
      { changes: { durationTicks: 0 }, message: /invalid timing or gain/i, operationMessage: /clip duration is outside/i },
      { changes: { durationTicks: -1 }, message: /invalid timing or gain/i, operationMessage: /clip duration is outside/i },
      { changes: { durationTicks: 1.5 }, message: /invalid timing or gain/i },
      { changes: { durationTicks: Number.NaN }, message: /invalid timing or gain/i, operationMessage: /clip duration is outside/i },
      { changes: { durationTicks: Number.POSITIVE_INFINITY }, message: /invalid timing or gain/i, operationMessage: /clip duration is outside/i },
      { changes: { durationTicks: 'duration' }, message: /invalid timing or gain/i, operationMessage: /clip duration is outside/i },
      { changes: { gainDb: -121 }, message: /invalid timing or gain/i },
      { changes: { gainDb: 25 }, message: /invalid timing or gain/i },
      { changes: { gainDb: Number.NaN }, message: /invalid timing or gain/i },
      { changes: { gainDb: Number.POSITIVE_INFINITY }, message: /invalid timing or gain/i },
      { changes: { gainDb: 'gain' }, message: /invalid timing or gain/i },
      { changes: { fadeIn: { durationTicks: Number.MAX_SAFE_INTEGER + 1, curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { fadeIn: { durationTicks: -1, curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { fadeIn: { durationTicks: 0.5, curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { fadeIn: { durationTicks: Number.NaN, curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { fadeOut: { durationTicks: Number.POSITIVE_INFINITY, curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { fadeOut: { durationTicks: 'fade', curve: 'linear' } }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: 0 }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: -1 }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: 0.5 }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: Number.NaN }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: Number.POSITIVE_INFINITY }, message: /invalid fade or loop timing/i },
      { changes: { loopLengthTicks: 'loop' }, message: /invalid fade or loop timing/i },
    ];

    for (const { changes, message, operationMessage = message } of invalidCases) {
      const caseLabel = JSON.stringify(changes);
      const stored = structuredClone(project);
      Object.assign(stored.clips[midi.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored), caseLabel).toThrow();
      expect(() => validateProjectIntegrity(stored), caseLabel).toThrow(message);

      const incoming = midiClip(midiTrack.id, { id: createId('clip'), name: 'Rejected numeric add', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: incoming }]), { authenticatedActor: AGENT }), caseLabel).toThrow(operationMessage);
      const update = { kind: 'clip.update', clipId: midi.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [update], REVIEWER), { authenticatedActor: REVIEWER }), caseLabel).toThrow(operationMessage);
      const right = midiClip(midiTrack.id, { name: 'Rejected numeric split', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.split', clipId: midi.id, tick: 960, rightClip: right }], REVIEWER), { authenticatedActor: REVIEWER }), caseLabel).toThrow(message);
    }

    const corruptTargetOperations: ProjectOperation[] = [
      { kind: 'clip.update', clipId: audio.id, changes: { fadeIn: { durationTicks: 0, curve: 'linear' } } } as unknown as ProjectOperation,
      { kind: 'clip.move', clipId: audio.id, trackId: audioTarget.id, startTick: 240 },
      { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: 960 },
      { kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: audioClip(audioTrack.id, media.id, { name: 'Valid right split' }) },
      { kind: 'clip.delete', clipId: audio.id },
      { kind: 'track.delete', trackId: audioTrack.id, cascade: true },
    ];
    for (const operation of corruptTargetOperations) {
      const corrupted = structuredClone(project); const current = corrupted.clips[audio.id] as AudioClip;
      current.fadeIn.durationTicks = Number.MAX_SAFE_INTEGER + 1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid fade or loop timing/i);
      expect(corrupted).toEqual(before);
    }

    const laneClip = midiClip(midiTrack.id, { name: 'Lane numeric clip' });
    const lane: TakeLane = { ...entityBase('lane', AGENT), trackId: midiTrack.id, name: 'Numeric lane', clipIds: [laneClip.id], active: true };
    const withLane = applyProjectTransaction(project, transaction(project.id, [{ kind: 'take-lane.add', lane }, { kind: 'clip.add', clip: { ...laneClip, takeLaneId: lane.id } }]), { authenticatedActor: AGENT }).project;
    const corruptedLane = structuredClone(withLane); (corruptedLane.clips[laneClip.id] as MidiClip).fadeOut.durationTicks = Number.MAX_SAFE_INTEGER + 1;
    const beforeLaneCleanup = structuredClone(corruptedLane);
    expect(() => applyProjectTransaction(corruptedLane, transaction(corruptedLane.id, [{ kind: 'take-lane.delete', laneId: lane.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid fade or loop timing/i);
    expect(corruptedLane).toEqual(beforeLaneCleanup);

    const malformedOperations: ProjectOperation[] = [
      { kind: 'clip.move', clipId: audio.id, trackId: audioTarget.id, startTick: Number.MAX_SAFE_INTEGER + 1 },
      { kind: 'clip.trim', clipId: audio.id, startTick: Number.MAX_SAFE_INTEGER + 1, durationTicks: 960 },
      { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: Number.MAX_SAFE_INTEGER + 1 },
      { kind: 'clip.split', clipId: audio.id, tick: 0.5, rightClip: audioClip(audioTrack.id, media.id, { name: 'Fractional split' }) },
    ];
    for (const operation of malformedOperations) {
      expect(() => validateTransaction(transaction(project.id, [operation], REVIEWER))).toThrow();
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid timing or gain/i);
    }

    const mixedStored = structuredClone(project); const mixedStoredClip = mixedStored.clips[audio.id] as AudioClip;
    mixedStoredClip.gainDb = 25; mixedStoredClip.sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => validateProjectIntegrity(mixedStored)).toThrow(/invalid timing or gain/i);
    const mixedSourceOperation = structuredClone(project); const mixedSourceClip = mixedSourceOperation.clips[audio.id] as AudioClip;
    mixedSourceClip.gainDb = 25; mixedSourceClip.sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(mixedSourceOperation, transaction(mixedSourceOperation.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid source bounds/i);
    const mixedMarkerOperation = structuredClone(project); const mixedMarkerClip = mixedMarkerOperation.clips[audio.id] as AudioClip;
    mixedMarkerClip.gainDb = 25; mixedMarkerClip.warpMarkers[0].revision = -1;
    expect(() => applyProjectTransaction(mixedMarkerOperation, transaction(mixedMarkerOperation.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    const mixedClipMetadata = structuredClone(project); const invalidClip = mixedClipMetadata.clips[audio.id] as AudioClip;
    invalidClip.revision = -1; invalidClip.gainDb = 25;
    expect(() => applyProjectTransaction(mixedClipMetadata, transaction(mixedClipMetadata.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    const invalidMutable = structuredClone(project); (invalidMutable.clips[audio.id] as AudioClip).gainDb = 25;
    expect(() => applyProjectTransaction(invalidMutable, transaction(invalidMutable.id, [{ kind: 'clip.update', clipId: audio.id, changes: { name: '' } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid text values/i);
    const invalidMoveTarget = structuredClone(project); (invalidMoveTarget.clips[audio.id] as AudioClip).gainDb = 25;
    expect(() => applyProjectTransaction(invalidMoveTarget, transaction(invalidMoveTarget.id, [{ kind: 'clip.move', clipId: audio.id, trackId: 'missing-track', startTick: 240 }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/target track is incompatible/i);
    const invalidTrimRange = structuredClone(project); (invalidTrimRange.clips[audio.id] as AudioClip).gainDb = 25;
    expect(() => applyProjectTransaction(invalidTrimRange, transaction(invalidTrimRange.id, [{ kind: 'clip.trim', clipId: audio.id, startTick: -1, durationTicks: 960 }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/clip start is outside/i);
    const invalidSplitTick = structuredClone(project); (invalidSplitTick.clips[audio.id] as AudioClip).gainDb = 25;
    expect(() => applyProjectTransaction(invalidSplitTick, transaction(invalidSplitTick.id, [{ kind: 'clip.split', clipId: audio.id, tick: 0, rightClip: audioClip(audioTrack.id, media.id) }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/split tick must be inside/i);
    expect(project).toEqual(original);
    expect(project.tracks[midiTarget.id]).toBeDefined();
  });
});
