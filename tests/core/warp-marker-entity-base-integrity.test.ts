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
  type EntityBase,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
  type WarpMarker,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-warp-entity-base', kind: 'agent', name: 'Warp Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-warp-entity-base', kind: 'human', name: 'Warp Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Warp marker entity metadata integrity', createdAt: nowIso(), operations };
}

function asset(): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'audio', name: 'Warp fixture.wav', mimeType: 'audio/wav', sha256: 'd'.repeat(64), byteLength: 96_000,
    storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
  };
}

function marker(sourceSample = 0, projectTick = 0): WarpMarker {
  return { ...entityBase('warp', AGENT), sourceSample, projectTick };
}

function audioClip(trackId: string, assetId: string, warpMarkers: WarpMarker[], name = 'Warp clip'): AudioClip {
  return {
    ...entityBase('clip', AGENT), kind: 'audio', trackId, assetId, name, color: '#14b8a6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo warp marker entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; sourceTrack: Track; targetTrack: Track; media: MediaAsset; audio: AudioClip; warp: WarpMarker } {
  const base = createProject('song', 'Warp marker EntityBase values', AGENT);
  const sourceTrack = createTrack('audio', 'Audio source', '#14b8a6', AGENT);
  const targetTrack = createTrack('audio', 'Audio target', '#06b6d4', AGENT);
  const media = asset();
  const warp = marker(1_024, 240);
  const audio = audioClip(sourceTrack.id, media.id, [warp]);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: sourceTrack },
    { kind: 'track.add', track: targetTrack },
    { kind: 'asset.add', asset: media },
    { kind: 'clip.add', clip: audio },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, targetTrack, media, audio, warp };
}

function operationWithWarpChanges(clipId: string, warpMarkers: WarpMarker[]): ProjectOperation {
  return { kind: 'clip.update', clipId, changes: { warpMarkers } } as unknown as ProjectOperation;
}

describe('audio warp-marker EntityBase declared metadata integrity', () => {
  it('preserves attribution, array order, values and semantic clip-operation inverses', () => {
    let project = createProject('song', 'Warp marker EntityBase lifecycles', AGENT);
    const sourceTrack = createTrack('audio', 'Audio source', '#14b8a6', AGENT);
    const targetTrack = createTrack('audio', 'Audio target', '#06b6d4', AGENT);
    const media = asset();
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: sourceTrack }, { kind: 'track.add', track: targetTrack }, { kind: 'asset.add', asset: media },
    ], AGENT), { authenticatedActor: AGENT }).project;

    const later = marker(4_096, 960); const earlier = marker(512, 120);
    const audio = audioClip(sourceTrack.id, media.id, [later, earlier]);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.add', clip: audio }]);
    let current = project.clips[audio.id] as AudioClip;
    expect(current.warpMarkers.map((value) => value.id)).toEqual([later.id, earlier.id]);
    expect(current.warpMarkers[0]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id, sourceSample: 4_096, projectTick: 960 });

    project = commitAndVerifyInverse(project, [operationWithWarpChanges(audio.id, [earlier, later])], REVIEWER);
    current = project.clips[audio.id] as AudioClip;
    expect(current.warpMarkers.map((value) => value.id)).toEqual([earlier.id, later.id]);
    for (const value of current.warpMarkers) expect(value).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'clip.move', clipId: audio.id, trackId: targetTrack.id, startTick: 240, index: 0, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[audio.id] as AudioClip;
    expect(current.warpMarkers.map((value) => [value.sourceSample, value.projectTick])).toEqual([[512, 120], [4_096, 960]]);
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.trim', clipId: audio.id, startTick: 240, durationTicks: 960, sourceStartSample: 128, sourceDurationSamples: 4_096, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[audio.id] as AudioClip;
    expect(current.warpMarkers.map((value) => value.id)).toEqual([earlier.id, later.id]);

    const rightMarker = marker(2_048, 480);
    const right = audioClip(targetTrack.id, media.id, [rightMarker], 'Right split');
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.split', clipId: audio.id, tick: 720, rightClip: right, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[audio.id] as AudioClip;
    const splitRight = project.clips[right.id] as AudioClip;
    expect(current.warpMarkers.map((value) => value.id)).toEqual([earlier.id, later.id]);
    expect(splitRight.warpMarkers).toEqual([rightMarker]);
    expect(splitRight.warpMarkers[0]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id, sourceSample: 2_048, projectTick: 480 });

    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: right.id, expectedRevision: splitRight.revision }], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: audio.id, expectedRevision: project.clips[audio.id].revision }], REVIEWER);
    expect(project.clips[right.id]).toBeUndefined();
    expect(project.clips[audio.id]).toBeUndefined();
  });

  it('accepts exact independent and duplicate boundaries and rejects malformed stored or clip-boundary metadata', () => {
    const { project, sourceTrack, targetTrack, media, audio, warp } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);

    const acceptedCases: Array<Partial<EntityBase>> = [
      { id: 'i' },
      { id: 'i'.repeat(240) },
      { revision: 0 },
      { revision: 42 },
      { createdAt: '2026-08-08T01:02:03Z', updatedAt: '2026-08-07T01:02:03.123456Z' },
      { createdBy: 'c' },
      { createdBy: 'c'.repeat(240) },
      { updatedBy: 'u' },
      { updatedBy: 'u'.repeat(240) },
    ];
    for (const changes of acceptedCases) {
      const accepted = structuredClone(project); const stored = accepted.clips[audio.id] as AudioClip;
      Object.assign(stored.warpMarkers[0], changes);
      validateProjectIntegrity(accepted);
    }
    const duplicateAndReverse = structuredClone(project); const duplicateClip = duplicateAndReverse.clips[audio.id] as AudioClip;
    duplicateClip.warpMarkers = [{ ...duplicateClip.warpMarkers[0], sourceSample: 8_192, projectTick: 960 }, { ...duplicateClip.warpMarkers[0], sourceSample: 128, projectTick: 120 }];
    validateProjectIntegrity(duplicateAndReverse);

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { id: '' }, message: /invalid entity ID/i },
      { changes: { id: 'i'.repeat(241) }, message: /invalid entity ID/i },
      { changes: { id: 42 }, message: /invalid entity ID/i },
      { changes: { revision: -1 }, message: /invalid entity revision/i },
      { changes: { revision: 0.5 }, message: /invalid entity revision/i },
      { changes: { revision: Number.NaN }, message: /invalid entity revision/i },
      { changes: { createdAt: '2026-02-30T00:00:00Z' }, message: /invalid creation timestamp/i },
      { changes: { createdAt: 42 }, message: /invalid creation timestamp/i },
      { changes: { updatedAt: '2026-08-07T00:00:00+00:00' }, message: /invalid update timestamp/i },
      { changes: { updatedAt: 42 }, message: /invalid update timestamp/i },
      { changes: { createdBy: '' }, message: /invalid creator ID/i },
      { changes: { createdBy: 'c'.repeat(241) }, message: /invalid creator ID/i },
      { changes: { createdBy: 42 }, message: /invalid creator ID/i },
      { changes: { updatedBy: '' }, message: /invalid updater ID/i },
      { changes: { updatedBy: 'u'.repeat(241) }, message: /invalid updater ID/i },
      { changes: { updatedBy: 42 }, message: /invalid updater ID/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalidStored = structuredClone(project); const stored = invalidStored.clips[audio.id] as AudioClip;
      Object.assign(stored.warpMarkers[0] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidStored)).toThrow(message);

      const incomingMarker = { ...marker(), ...changes } as unknown as WarpMarker;
      const added = audioClip(sourceTrack.id, media.id, [incomingMarker], 'Rejected add');
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: added }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      expect(() => applyProjectTransaction(project, transaction(project.id, [operationWithWarpChanges(audio.id, [incomingMarker])], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
      const right = audioClip(sourceTrack.id, media.id, [incomingMarker], 'Rejected split');
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: right }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const validReplacement = marker(2_048, 480);
    const invalidExistingOperations: ProjectOperation[] = [
      operationWithWarpChanges(audio.id, [validReplacement]),
      { kind: 'clip.move', clipId: audio.id, trackId: targetTrack.id, startTick: 240 },
      { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: 960 },
      { kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: audioClip(sourceTrack.id, media.id, [validReplacement], 'Right split') },
      { kind: 'clip.delete', clipId: audio.id },
    ];
    for (const operation of invalidExistingOperations) {
      const invalid = structuredClone(project); const current = invalid.clips[audio.id] as AudioClip;
      current.warpMarkers[0].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidCascade = structuredClone(project); const cascadeClip = invalidCascade.clips[audio.id] as AudioClip;
    cascadeClip.warpMarkers[0].revision = -1;
    expect(() => applyProjectTransaction(invalidCascade, transaction(invalidCascade.id, [{ kind: 'track.delete', trackId: sourceTrack.id, cascade: true }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    expect(project).toEqual(original);
    expect((project.clips[audio.id] as AudioClip).warpMarkers[0]).toEqual(warp);
  });
});
