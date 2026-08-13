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
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
  type Track,
  type WarpMarker,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-audio-source', kind: 'agent', name: 'Audio Source Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-audio-source', kind: 'human', name: 'Audio Source Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Audio clip source integrity', createdAt: nowIso(), operations };
}

function asset(id = createId('asset')): MediaAsset {
  return {
    ...entityBase('asset', AGENT), id, kind: 'audio', name: 'Source fixture.wav', mimeType: 'audio/wav', sha256: 'f'.repeat(64), byteLength: 96_000,
    storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
  };
}

function marker(): WarpMarker {
  return { ...entityBase('warp', AGENT), sourceSample: 1_024, projectTick: 240 };
}

function audioClip(trackId: string, assetId: string, overrides: Record<string, unknown> = {}): AudioClip {
  return {
    ...entityBase('clip', AGENT), kind: 'audio', trackId, assetId, name: 'Audio source clip', color: '#14b8a6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers: [marker()], ...overrides,
  } as AudioClip;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  validateProjectIntegrity(committed.project);
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo audio source operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; sourceTrack: Track; targetTrack: Track; media: MediaAsset; audio: AudioClip } {
  const base = createProject('song', 'Audio source declared values', AGENT);
  const sourceTrack = createTrack('audio', 'Source audio', '#14b8a6', AGENT);
  const targetTrack = createTrack('audio', 'Target audio', '#06b6d4', AGENT);
  const media = asset();
  const audio = audioClip(sourceTrack.id, media.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: sourceTrack },
    { kind: 'track.add', track: targetTrack },
    { kind: 'asset.add', asset: media },
    { kind: 'clip.add', clip: audio },
  ]), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, targetTrack, media, audio };
}

describe('audio clip source declared-value integrity', () => {
  it('preserves exact independent boundaries, repeated asset references, order, attribution and semantic inverses', () => {
    const base = createProject('song', 'Audio source boundaries', AGENT);
    const sourceTrack = createTrack('audio', 'Boundary source', '#14b8a6', AGENT);
    const targetTrack = createTrack('audio', 'Boundary target', '#06b6d4', AGENT);
    const minimumMedia = asset('b');
    const media = asset('a'.repeat(240));
    const prepared = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'track.add', track: sourceTrack }, { kind: 'track.add', track: targetTrack }, { kind: 'asset.add', asset: minimumMedia }, { kind: 'asset.add', asset: media },
    ]), { authenticatedActor: AGENT }).project;
    const lower = audioClip(sourceTrack.id, minimumMedia.id, { name: 'Lower source boundary', sourceStartSample: 0, sourceDurationSamples: 1, transposeSemitones: -48 });
    const upper = audioClip(sourceTrack.id, media.id, { name: 'Upper source boundary', sourceStartSample: Number.MAX_SAFE_INTEGER, sourceDurationSamples: Number.MAX_SAFE_INTEGER, transposeSemitones: 48 });

    let project = commitAndVerifyInverse(prepared, [{ kind: 'clip.add', clip: lower }, { kind: 'clip.add', clip: upper }]);
    expect(project.tracks[sourceTrack.id].clipIds).toEqual([lower.id, upper.id]);
    expect([project.clips[lower.id], project.clips[upper.id]].map((clip) => [clip.kind === 'audio' ? clip.assetId : '', clip.kind === 'audio' ? clip.sourceStartSample : -1, clip.kind === 'audio' ? clip.sourceDurationSamples : -1, clip.kind === 'audio' ? clip.transposeSemitones : 0])).toEqual([
      [minimumMedia.id, 0, 1, -48], [media.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 48],
    ]);
    expect(project.clips[lower.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });

    project = commitAndVerifyInverse(project, [{ kind: 'clip.update', clipId: lower.id, changes: { sourceStartSample: Number.MAX_SAFE_INTEGER, sourceDurationSamples: 1, transposeSemitones: 48 } } as unknown as ProjectOperation], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.move', clipId: upper.id, trackId: targetTrack.id, startTick: 240 }], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.trim', clipId: lower.id, startTick: 120, durationTicks: 960, sourceStartSample: 0, sourceDurationSamples: Number.MAX_SAFE_INTEGER }], REVIEWER);
    const right = audioClip(sourceTrack.id, media.id, { name: 'Right source boundary', sourceStartSample: Number.MAX_SAFE_INTEGER, sourceDurationSamples: 1, transposeSemitones: -48 });
    project = commitAndVerifyInverse(project, [{ kind: 'clip.split', clipId: lower.id, tick: 600, rightClip: right }], REVIEWER);
    expect(project.tracks[sourceTrack.id].clipIds).toEqual([lower.id, right.id]);
    expect(project.clips[right.id]).toMatchObject({ assetId: media.id, sourceStartSample: Number.MAX_SAFE_INTEGER, sourceDurationSamples: 1, transposeSemitones: -48, createdBy: REVIEWER.id });
    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: right.id }], REVIEWER);
    expect(project.clips[right.id]).toBeUndefined();
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects malformed stored, incoming, replacement, trim, existing-target, split and cascade values with established precedence', () => {
    const { project, sourceTrack, targetTrack, media, audio } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { sourceStartSample: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid source bounds/i },
      { changes: { sourceStartSample: -1 }, message: /invalid source bounds/i },
      { changes: { sourceStartSample: 0.5 }, message: /invalid source bounds/i },
      { changes: { sourceStartSample: Number.NaN }, message: /invalid source bounds/i },
      { changes: { sourceStartSample: Number.POSITIVE_INFINITY }, message: /invalid source bounds/i },
      { changes: { sourceStartSample: 'sample' }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: 0 }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: -1 }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: 0.5 }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: Number.NaN }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: Number.POSITIVE_INFINITY }, message: /invalid source bounds/i },
      { changes: { sourceDurationSamples: 'duration' }, message: /invalid source bounds/i },
      { changes: { transposeSemitones: -49 }, message: /invalid source bounds/i },
      { changes: { transposeSemitones: 49 }, message: /invalid source bounds/i },
      { changes: { transposeSemitones: Number.NaN }, message: /invalid source bounds/i },
      { changes: { transposeSemitones: Number.POSITIVE_INFINITY }, message: /invalid source bounds/i },
      { changes: { transposeSemitones: 'transpose' }, message: /invalid source bounds/i },
      { changes: { assetId: '' }, message: /references missing media/i },
      { changes: { assetId: 'a'.repeat(241) }, message: /references missing media/i },
      { changes: { assetId: 42 }, message: /references missing media/i },
      { changes: { assetId: 'missing-asset' }, message: /references missing media/i },
    ];

    for (const { changes, message } of invalidCases) {
      const stored = structuredClone(project);
      Object.assign(stored.clips[audio.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incoming = audioClip(sourceTrack.id, media.id, { id: createId('clip'), name: 'Rejected source add', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: incoming }]), { authenticatedActor: AGENT })).toThrow(message);
      const update = { kind: 'clip.update', clipId: audio.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [update], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
      const right = audioClip(sourceTrack.id, media.id, { name: 'Rejected source split', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: right }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const corruptTargetOperations: ProjectOperation[] = [
      { kind: 'clip.update', clipId: audio.id, changes: { sourceStartSample: 0 } } as unknown as ProjectOperation,
      { kind: 'clip.move', clipId: audio.id, trackId: targetTrack.id, startTick: 240 },
      { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: 960, sourceStartSample: 0 },
      { kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: audioClip(sourceTrack.id, media.id, { name: 'Valid right split' }) },
      { kind: 'clip.delete', clipId: audio.id },
      { kind: 'track.delete', trackId: sourceTrack.id, cascade: true },
    ];
    for (const operation of corruptTargetOperations) {
      const corrupted = structuredClone(project);
      (corrupted.clips[audio.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid source bounds/i);
      expect(corrupted).toEqual(before);
    }

    const laneClip = audioClip(sourceTrack.id, media.id, { name: 'Lane source clip' });
    const lane: TakeLane = { ...entityBase('lane', AGENT), trackId: sourceTrack.id, name: 'Source lane', clipIds: [laneClip.id], active: true };
    const withLane = applyProjectTransaction(project, transaction(project.id, [{ kind: 'take-lane.add', lane }, { kind: 'clip.add', clip: { ...laneClip, takeLaneId: lane.id } }]), { authenticatedActor: AGENT }).project;
    const corruptedLane = structuredClone(withLane); (corruptedLane.clips[laneClip.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    const beforeLaneCleanup = structuredClone(corruptedLane);
    expect(() => applyProjectTransaction(corruptedLane, transaction(corruptedLane.id, [{ kind: 'take-lane.delete', laneId: lane.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid source bounds/i);
    expect(corruptedLane).toEqual(beforeLaneCleanup);

    const invalidTrimValues: Array<Pick<ProjectOperation & { kind: 'clip.trim' }, 'sourceStartSample' | 'sourceDurationSamples'>> = [
      { sourceStartSample: -1 }, { sourceStartSample: 0.5 }, { sourceStartSample: Number.MAX_SAFE_INTEGER + 1 },
      { sourceDurationSamples: 0 }, { sourceDurationSamples: 0.5 }, { sourceDurationSamples: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const changes of invalidTrimValues) {
      const operation = { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: 960, ...changes } as ProjectOperation;
      expect(() => validateTransaction(transaction(project.id, [operation], REVIEWER))).toThrow();
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid source bounds/i);
    }

    const mixedStored = structuredClone(project); const mixedStoredClip = mixedStored.clips[audio.id] as AudioClip;
    mixedStoredClip.sourceStartSample = Number.MAX_SAFE_INTEGER + 1; mixedStoredClip.warpMarkers[0].revision = -1;
    expect(() => validateProjectIntegrity(mixedStored)).toThrow(/invalid source bounds/i);
    const mixedOperation = structuredClone(project); const mixedOperationClip = mixedOperation.clips[audio.id] as AudioClip;
    mixedOperationClip.sourceStartSample = Number.MAX_SAFE_INTEGER + 1; mixedOperationClip.warpMarkers[0].revision = -1;
    expect(() => applyProjectTransaction(mixedOperation, transaction(mixedOperation.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    const mixedClipMetadata = structuredClone(project); const invalidClip = mixedClipMetadata.clips[audio.id] as AudioClip;
    invalidClip.revision = -1; invalidClip.sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(mixedClipMetadata, transaction(mixedClipMetadata.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    const invalidMutable = structuredClone(project); (invalidMutable.clips[audio.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(invalidMutable, transaction(invalidMutable.id, [{ kind: 'clip.update', clipId: audio.id, changes: { name: '' } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid text values/i);
    const invalidMoveTarget = structuredClone(project); (invalidMoveTarget.clips[audio.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(invalidMoveTarget, transaction(invalidMoveTarget.id, [{ kind: 'clip.move', clipId: audio.id, trackId: 'missing-track', startTick: 240 }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/target track is incompatible/i);
    const invalidTrimRange = structuredClone(project); (invalidTrimRange.clips[audio.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(invalidTrimRange, transaction(invalidTrimRange.id, [{ kind: 'clip.trim', clipId: audio.id, startTick: -1, durationTicks: 960 }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/clip start is outside/i);
    const invalidSplitTick = structuredClone(project); (invalidSplitTick.clips[audio.id] as AudioClip).sourceStartSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(invalidSplitTick, transaction(invalidSplitTick.id, [{ kind: 'clip.split', clipId: audio.id, tick: 0, rightClip: audioClip(sourceTrack.id, media.id) }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/split tick must be inside/i);
    expect(project).toEqual(original);
  });
});
