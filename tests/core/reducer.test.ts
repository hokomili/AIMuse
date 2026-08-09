import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  MAX_RECENT_ACTIVITY_ENTRIES,
  TransactionConflictError,
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  type Actor,
  type MediaAsset,
  type MidiClip,
  type MidiNote,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-test', kind: 'agent', name: 'Test Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Test transaction', createdAt: nowIso(), operations };
}

function midiNote(pitch: number, startTick: number): MidiNote {
  return { ...entityBase('note', AGENT), startTick, durationTicks: 240, pitch, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
}

function midiClip(trackId: string): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name: 'Idea', color: '#8b5cf6', startTick: 0, durationTicks: 3840,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' },
    loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

describe('project reducer', () => {
  it('commits granular MIDI edits and normalizes attribution', () => {
    const project = createProject('song', 'Reducer Test');
    const instrument = project.tracks[project.trackOrder[0]];
    const clip = midiClip(instrument.id);
    const note = midiNote(60, 137);
    const result = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'clip.add', clip },
      { kind: 'midi.note.add', clipId: clip.id, note },
      { kind: 'midi.semantic', clipId: clip.id, action: 'quantize', gridTicks: 240, strength: 1 },
    ]), { authenticatedActor: AGENT });

    const committed = result.project.clips[clip.id] as MidiClip;
    expect(committed.notes[note.id].startTick).toBe(240);
    expect(committed.createdBy).toBe(AGENT.id);
    expect(result.transaction.actor.client?.model).toBe('fixture');
    expect(result.project.revision).toBe(1);
    expect(result.project.activity.at(-1)?.actor.id).toBe(AGENT.id);
  });

  it('provides actor-scoped reversible patches', () => {
    const project = createProject('song', 'Before');
    const result = applyProjectTransaction(project, transaction(project.id, [{ kind: 'project.rename', name: 'After' }]));
    const undone = applyHistoryPatches(result.project, result.inversePatches, AGENT, 'Undo rename', 'undo');
    expect(result.project.name).toBe('After');
    expect(undone.name).toBe('Before');
    expect(undone.revision).toBe(2);
    expect(undone.activity.at(-1)?.status).toBe('undo');
  });

  it('edits and splits first-class MIDI CC and pitch-bend events', () => {
    const project = createProject('song', 'Expression');
    const track = project.tracks[project.trackOrder[0]];
    const clip = midiClip(track.id);
    const control = { ...entityBase('cc', AGENT), tick: 2_000, controller: 1, value: 0.75, channel: 0 };
    const bend = { ...entityBase('bend', AGENT), tick: 2_100, value: 0.5, channel: 0 };
    const populated = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'clip.add', clip },
      { kind: 'midi.control.add', clipId: clip.id, event: control },
      { kind: 'midi.pitch-bend.add', clipId: clip.id, event: bend },
    ])).project;
    const revision = populated.clips[clip.id].revision;
    const updated = applyProjectTransaction(populated, transaction(project.id, [{ kind: 'midi.pitch-bend.update', clipId: clip.id, eventId: bend.id, changes: { value: -0.25 }, expectedRevision: revision }])).project;
    const right = midiClip(track.id);
    const split = applyProjectTransaction(updated, transaction(project.id, [{ kind: 'clip.split', clipId: clip.id, tick: 1_920, rightClip: right, expectedRevision: updated.clips[clip.id].revision }])).project;
    const leftClip = split.clips[clip.id] as MidiClip;
    const rightClip = split.clips[right.id] as MidiClip;
    expect(leftClip.pitchBendOrder).toEqual([]);
    expect(rightClip.controls[control.id].tick).toBe(80);
    expect(rightClip.pitchBends[bend.id]).toMatchObject({ tick: 180, value: -0.25 });
  });

  it('rejects stale entity revisions with retry guidance', () => {
    const project = createProject('song');
    const track = project.tracks[project.trackOrder[0]];
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.update', trackId: track.id, changes: { name: 'Stale' }, expectedRevision: 9 }]))).toThrow(TransactionConflictError);
    try {
      applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.update', trackId: track.id, changes: { name: 'Stale' }, expectedRevision: 9 }]));
    } catch (error) {
      expect((error as TransactionConflictError).conflict.retryable).toBe(true);
      expect((error as TransactionConflictError).conflict.actualRevision).toBe(0);
    }
  });

  it('requires explicit cascade deletion and preserves the master', () => {
    const project = createProject('song');
    const track = project.tracks[project.trackOrder[0]];
    const clip = midiClip(track.id);
    const withClip = applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip }])).project;
    expect(() => applyProjectTransaction(withClip, transaction(project.id, [{ kind: 'track.delete', trackId: track.id, cascade: false }]))).toThrow(/not empty/i);
    const deleted = applyProjectTransaction(withClip, transaction(project.id, [{ kind: 'track.delete', trackId: track.id, cascade: true }])).project;
    expect(deleted.tracks[track.id]).toBeUndefined();
    expect(Object.values(deleted.tracks).filter((value) => value.kind === 'master')).toHaveLength(1);
  });

  it('prevents deleting referenced media', () => {
    const project = createProject('song');
    const audioTrack = createTrack('audio', 'Audio', '#14b8a6', HUMAN_ACTOR);
    audioTrack.routing.outputTrackId = Object.values(project.tracks).find((track) => track.kind === 'master')?.id;
    const asset: MediaAsset = { ...entityBase('asset', AGENT), kind: 'audio', name: 'Tone.wav', mimeType: 'audio/wav', sha256: 'a'.repeat(64), byteLength: 44, storage: 'embedded', sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import' };
    const clip = { ...entityBase('clip', AGENT), kind: 'audio' as const, trackId: audioTrack.id, name: 'Tone', color: '#14b8a6', startTick: 0, durationTicks: 1920, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' as const }, fadeOut: { durationTicks: 0, curve: 'linear' as const }, loopEnabled: false, assetId: asset.id, sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch' as const, reverse: false, warpMarkers: [] };
    const populated = applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: audioTrack }, { kind: 'asset.add', asset }, { kind: 'clip.add', clip }])).project;
    expect(() => applyProjectTransaction(populated, transaction(project.id, [{ kind: 'asset.delete', assetId: asset.id }]))).toThrow(/referenced/i);
  });

  it('bounds materialized activity while preserving the newest attributed commit', () => {
    const project = createProject('song', 'Activity retention');
    project.activity = Array.from({ length: MAX_RECENT_ACTIVITY_ENTRIES }, (_, index) => ({ id: `activity-${index}`, actor: AGENT, transactionId: `historical-${index}`, label: `Historical ${index}`, status: 'committed' as const, createdAt: new Date(index).toISOString(), revision: index + 1 }));
    const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'project.rename', name: 'Newest' }]), { authenticatedActor: AGENT }).project;
    expect(committed.activity).toHaveLength(MAX_RECENT_ACTIVITY_ENTRIES);
    expect(committed.activity[0].transactionId).toBe('historical-1');
    expect(committed.activity.at(-1)).toMatchObject({ actor: AGENT, label: 'Test transaction', revision: 1 });
  });
});
