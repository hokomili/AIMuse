import { describe, expect, it } from 'vitest';
import { applyProjectTransaction, createProject, HUMAN_ACTOR } from '@aimuse/core';
import { makeMidiClip, makeTrackVolumeAutomation, rebaseUiTransaction, timelineTickFromPointer, transaction } from '../../src/renderer/editor-helpers';

describe('timeline pointer conversion', () => {
  it('maps exact ruler positions to unsnapped ticks and clamps before the origin', () => {
    expect(timelineTickFromPointer(150.25, 100, 12.5)).toBe(628);
    expect(timelineTickFromPointer(80, 100, 12.5)).toBe(0);
    expect(timelineTickFromPointer(Number.NaN, 100, 12.5)).toBe(0);
  });
});

describe('renderer transaction preparation', () => {
  it('rebases queued human revision guards without changing the operation intent', () => {
    const project = createProject('song');
    const track = project.tracks[project.trackOrder[0]];
    track.revision = 7;
    const edit = transaction(project, 'Queued mute', [{ kind: 'track.update', trackId: track.id, changes: { mute: true }, expectedRevision: 0 }]);

    const rebased = rebaseUiTransaction(edit, project);
    expect(rebased).not.toBe(edit);
    expect(rebased.clientOperationId).toBe(edit.clientOperationId);
    expect(rebased.operations[0]).toMatchObject({ kind: 'track.update', changes: { mute: true }, expectedRevision: 7 });
  });

  it('creates a valid visible volume-automation lane for the selected track', () => {
    const project = createProject('song');
    const trackId = project.trackOrder[0];
    const lane = makeTrackVolumeAutomation(project, trackId);
    const applied = applyProjectTransaction(project, transaction(project, 'Add automation', [{ kind: 'automation.lane.add', lane }]), { authenticatedActor: HUMAN_ACTOR }).project;

    expect(applied.automationLanes[lane.id]).toMatchObject({ trackId, target: { kind: 'track', parameter: 'gainDb' }, visible: true });
    expect(applied.tracks[trackId].automationLaneIds).toContain(lane.id);
  });

  it('rebases MIDI clip edits against the current clip revision', () => {
    const project = createProject('song');
    const trackId = project.trackOrder[0];
    const clip = makeMidiClip(trackId, 0);
    clip.revision = 11;
    project.clips[clip.id] = clip;
    project.tracks[trackId].clipIds.push(clip.id);
    const edit = transaction(project, 'Queued note', [{ kind: 'midi.note.add', clipId: clip.id, note: { ...laneEntity('note'), startTick: 0, durationTicks: 240, pitch: 60, velocity: 0.8, releaseVelocity: 0.5, channel: 1, probability: 1 }, expectedRevision: 3 }]);

    expect(rebaseUiTransaction(edit, project).operations[0]).toMatchObject({ expectedRevision: 11 });
  });
});

function laneEntity(prefix: string) {
  const timestamp = new Date().toISOString();
  return { id: `${prefix}_test`, revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, updatedBy: HUMAN_ACTOR.id };
}
