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
  type Actor,
  type AIMuseProject,
  type AudioClip,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
  type WarpMarker,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-warp-declared', kind: 'agent', name: 'Warp Declared Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-warp-declared', kind: 'human', name: 'Warp Declared Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Warp marker declared integrity', createdAt: nowIso(), operations };
}

function asset(): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'audio', name: 'Warp declared.wav', mimeType: 'audio/wav', sha256: 'e'.repeat(64), byteLength: 96_000,
    storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
  };
}

function marker(overrides: Record<string, unknown> = {}): WarpMarker {
  return { ...entityBase('warp', AGENT), sourceSample: 1_024, projectTick: 240, ...overrides } as WarpMarker;
}

function audioClip(trackId: string, assetId: string, warpMarkers: WarpMarker[], name = 'Warp declared clip'): AudioClip {
  return {
    ...entityBase('clip', AGENT), kind: 'audio', trackId, assetId, name, color: '#14b8a6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function populatedProject(): { project: AIMuseProject; sourceTrack: Track; targetTrack: Track; media: MediaAsset; audio: AudioClip; warp: WarpMarker } {
  const base = createProject('song', 'Warp marker declared values', AGENT);
  const sourceTrack = createTrack('audio', 'Warp source', '#14b8a6', AGENT);
  const targetTrack = createTrack('audio', 'Warp target', '#06b6d4', AGENT);
  const media = asset();
  const warp = marker();
  const audio = audioClip(sourceTrack.id, media.id, [warp]);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: sourceTrack },
    { kind: 'track.add', track: targetTrack },
    { kind: 'asset.add', asset: media },
    { kind: 'clip.add', clip: audio },
  ]), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, targetTrack, media, audio, warp };
}

function replacement(clipId: string, warpMarkers: WarpMarker[]): ProjectOperation {
  return { kind: 'clip.update', clipId, changes: { warpMarkers } } as unknown as ProjectOperation;
}

describe('audio warp-marker declared-value integrity', () => {
  it('preserves exact safe-integer boundaries, explicit duplicate order, attribution and semantic inverses', () => {
    const base = createProject('song', 'Warp marker boundaries', AGENT);
    const sourceTrack = createTrack('audio', 'Boundary source', '#14b8a6', AGENT);
    const media = asset();
    const prepared = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'track.add', track: sourceTrack }, { kind: 'asset.add', asset: media },
    ]), { authenticatedActor: AGENT }).project;
    const boundary = marker({ id: 'w'.repeat(240), sourceSample: Number.MAX_SAFE_INTEGER, projectTick: 0 });
    const duplicate = { ...boundary, sourceSample: 0, projectTick: Number.MAX_SAFE_INTEGER };
    const audio = audioClip(sourceTrack.id, media.id, [boundary, duplicate]);
    const committed = applyProjectTransaction(prepared, transaction(prepared.id, [{ kind: 'clip.add', clip: audio }]), { authenticatedActor: AGENT });

    expect(() => validateProject(committed.project)).not.toThrow();
    validateProjectIntegrity(committed.project);
    expect((committed.project.clips[audio.id] as AudioClip).warpMarkers.map((value) => [value.id, value.sourceSample, value.projectTick])).toEqual([
      [boundary.id, Number.MAX_SAFE_INTEGER, 0], [boundary.id, 0, Number.MAX_SAFE_INTEGER],
    ]);
    for (const value of (committed.project.clips[audio.id] as AudioClip).warpMarkers) expect(value).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo warp boundaries', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(prepared));
  });

  it('rejects malformed stored, incoming, replacement, existing-target and cascade values with metadata precedence', () => {
    const { project, sourceTrack, targetTrack, media, audio, warp } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<Record<string, unknown>> = [
      { sourceSample: Number.MAX_SAFE_INTEGER + 1 },
      { sourceSample: -1 }, { sourceSample: 0.5 }, { sourceSample: Number.NaN }, { sourceSample: Number.POSITIVE_INFINITY }, { sourceSample: 'sample' },
      { projectTick: Number.MAX_SAFE_INTEGER + 1 },
      { projectTick: -1 }, { projectTick: 0.5 }, { projectTick: Number.NaN }, { projectTick: Number.POSITIVE_INFINITY }, { projectTick: 'tick' },
    ];
    for (const changes of invalidCases) {
      const stored = structuredClone(project); const storedClip = stored.clips[audio.id] as AudioClip;
      Object.assign(storedClip.warpMarkers[0] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(/invalid warp timing/i);

      const incomingMarker = marker(changes);
      const added = audioClip(sourceTrack.id, media.id, [incomingMarker], 'Rejected warp add');
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: added }]), { authenticatedActor: AGENT })).toThrow(/invalid warp timing/i);
      expect(() => applyProjectTransaction(project, transaction(project.id, [replacement(audio.id, [incomingMarker])], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid warp timing/i);
      const right = audioClip(sourceTrack.id, media.id, [incomingMarker], 'Rejected warp split');
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: right }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid warp timing/i);
    }

    const validReplacement = marker({ sourceSample: 2_048, projectTick: 480 });
    const corruptTargetOperations: ProjectOperation[] = [
      replacement(audio.id, [validReplacement]),
      { kind: 'clip.move', clipId: audio.id, trackId: targetTrack.id, startTick: 240 },
      { kind: 'clip.trim', clipId: audio.id, startTick: 120, durationTicks: 960 },
      { kind: 'clip.split', clipId: audio.id, tick: 960, rightClip: audioClip(sourceTrack.id, media.id, [validReplacement], 'Right split') },
      { kind: 'clip.delete', clipId: audio.id },
      { kind: 'track.delete', trackId: sourceTrack.id, cascade: true },
    ];
    for (const operation of corruptTargetOperations) {
      const corrupted = structuredClone(project); const current = corrupted.clips[audio.id] as AudioClip;
      current.warpMarkers[0].sourceSample = Number.MAX_SAFE_INTEGER + 1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid warp timing/i);
      expect(corrupted).toEqual(before);
    }

    const mixedMarkerMetadata = structuredClone(project); const mixedClip = mixedMarkerMetadata.clips[audio.id] as AudioClip;
    mixedClip.warpMarkers = [marker({ sourceSample: Number.MAX_SAFE_INTEGER + 1 }), marker({ revision: -1 })];
    expect(() => applyProjectTransaction(mixedMarkerMetadata, transaction(mixedMarkerMetadata.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    const mixedClipMetadata = structuredClone(project); const invalidClip = mixedClipMetadata.clips[audio.id] as AudioClip;
    invalidClip.revision = -1; invalidClip.warpMarkers[0].sourceSample = Number.MAX_SAFE_INTEGER + 1;
    expect(() => applyProjectTransaction(mixedClipMetadata, transaction(mixedClipMetadata.id, [{ kind: 'clip.delete', clipId: audio.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    expect(project).toEqual(original);
    expect((project.clips[audio.id] as AudioClip).warpMarkers[0]).toEqual(warp);
  });
});
