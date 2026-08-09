import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type MidiClip,
  type MidiControlEvent,
  type MidiNote,
  type MidiPitchBendEvent,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-midi-events', kind: 'agent', name: 'MIDI Event Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-midi-reviewer', kind: 'agent', name: 'MIDI Event Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'MIDI event integrity', createdAt: nowIso(), operations };
}

function clip(trackId: string): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name: 'MIDI events', color: '#8b5cf6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function note(startTick: number, pitch = 60): MidiNote {
  return { ...entityBase('note', AGENT), startTick, durationTicks: 240, pitch, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
}

function control(tick: number, controller = 1): MidiControlEvent {
  return { ...entityBase('control', AGENT), tick, controller, value: 0.75, channel: 0 };
}

function bend(tick: number, value = 0.5): MidiPitchBendEvent {
  return { ...entityBase('bend', AGENT), tick, value, channel: 0 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo MIDI event operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const project = createProject('song', 'MIDI event integrity');
  const track = project.tracks[project.trackOrder[0]];
  const midi = clip(track.id);
  const midiNote = note(120);
  const midiControl = control(240);
  const pitchBend = bend(360);
  return {
    project: applyProjectTransaction(project, transaction(project.id, [
      { kind: 'clip.add', clip: midi },
      { kind: 'midi.note.add', clipId: midi.id, note: midiNote },
      { kind: 'midi.control.add', clipId: midi.id, event: midiControl },
      { kind: 'midi.pitch-bend.add', clipId: midi.id, event: pitchBend },
    ], AGENT), { authenticatedActor: AGENT }).project,
    midi,
    midiNote,
    midiControl,
    pitchBend,
  };
}

describe('MIDI note, control and pitch-bend integrity', () => {
  it('keeps insertion ordering and declared event lifecycles semantically invertible', () => {
    let project = createProject('song', 'MIDI event inverses');
    const track = project.tracks[project.trackOrder[0]];
    const midi = clip(track.id);
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: midi }], AGENT), { authenticatedActor: AGENT }).project;

    const laterNote = note(960, 67);
    const earlierNote = note(120, 60);
    project = commitAndVerifyInverse(project, [
      { kind: 'midi.note.add', clipId: midi.id, note: laterNote },
      { kind: 'midi.note.add', clipId: midi.id, note: earlierNote },
    ]);
    let current = project.clips[midi.id] as MidiClip;
    expect(current.noteOrder).toEqual([laterNote.id, earlierNote.id]);
    const noteCreatedAt = current.notes[earlierNote.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'midi.note.update', clipId: midi.id, noteId: earlierNote.id,
      changes: { startTick: 60, durationTicks: 480, pitch: 64, velocity: 0.6, releaseVelocity: 0.4, channel: 1, probability: 0.75 },
      expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.noteOrder).toEqual([laterNote.id, earlierNote.id]);
    expect(current.notes[earlierNote.id]).toMatchObject({ createdAt: noteCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, startTick: 60, pitch: 64 });
    project = commitAndVerifyInverse(project, [{ kind: 'midi.note.delete', clipId: midi.id, noteId: laterNote.id, expectedRevision: current.revision }]);
    current = project.clips[midi.id] as MidiClip;
    expect(current.notes[laterNote.id]).toBeUndefined();
    expect(current.noteOrder).toEqual([earlierNote.id]);

    const laterControl = control(900, 11);
    const earlierControl = control(100, 1);
    project = commitAndVerifyInverse(project, [
      { kind: 'midi.control.add', clipId: midi.id, event: laterControl },
      { kind: 'midi.control.add', clipId: midi.id, event: earlierControl },
    ]);
    current = project.clips[midi.id] as MidiClip;
    expect(current.controlOrder).toEqual([laterControl.id, earlierControl.id]);
    expect(current.controls[earlierControl.id]).toMatchObject({ createdBy: AGENT.id, value: 0.75 });
    project = commitAndVerifyInverse(project, [{ kind: 'midi.control.delete', clipId: midi.id, eventId: laterControl.id, expectedRevision: current.revision }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.controls[laterControl.id]).toBeUndefined();
    expect(current.controlOrder).toEqual([earlierControl.id]);

    const laterBend = bend(800, 0.5);
    const earlierBend = bend(50, -0.25);
    project = commitAndVerifyInverse(project, [
      { kind: 'midi.pitch-bend.add', clipId: midi.id, event: laterBend },
      { kind: 'midi.pitch-bend.add', clipId: midi.id, event: earlierBend },
    ]);
    current = project.clips[midi.id] as MidiClip;
    expect(current.pitchBendOrder).toEqual([laterBend.id, earlierBend.id]);
    const bendCreatedAt = current.pitchBends[laterBend.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'midi.pitch-bend.update', clipId: midi.id, eventId: laterBend.id, changes: { tick: 20, value: -0.5, channel: 2 }, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.pitchBendOrder).toEqual([laterBend.id, earlierBend.id]);
    expect(current.pitchBends[laterBend.id]).toMatchObject({ createdAt: bendCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, tick: 20, value: -0.5 });
    project = commitAndVerifyInverse(project, [{ kind: 'midi.pitch-bend.delete', clipId: midi.id, eventId: earlierBend.id, expectedRevision: current.revision }]);
    current = project.clips[midi.id] as MidiClip;
    expect(current.pitchBends[earlierBend.id]).toBeUndefined();
    expect(current.pitchBendOrder).toEqual([laterBend.id]);
  });

  it('rejects incomplete identity/order mappings and every declared event range violation', () => {
    const { project, midi, midiNote, midiControl, pitchBend } = populatedProject();
    validateProjectIntegrity(project);

    const duplicateOrder = structuredClone(project);
    (duplicateOrder.clips[midi.id] as MidiClip).noteOrder.push(midiNote.id);
    expect(() => validateProjectIntegrity(duplicateOrder)).toThrow(/invalid note order/i);

    const missingOrderEntry = structuredClone(project);
    (missingOrderEntry.clips[midi.id] as MidiClip).controlOrder.push('missing-control');
    expect(() => validateProjectIntegrity(missingOrderEntry)).toThrow(/invalid control order/i);

    const unindexedEvent = structuredClone(project);
    const unindexedBend = { ...(unindexedEvent.clips[midi.id] as MidiClip).pitchBends[pitchBend.id], id: 'unindexed-bend' };
    (unindexedEvent.clips[midi.id] as MidiClip).pitchBends[unindexedBend.id] = unindexedBend;
    expect(() => validateProjectIntegrity(unindexedEvent)).toThrow(/invalid pitch-bend order/i);

    const mismatchedIdentity = structuredClone(project);
    (mismatchedIdentity.clips[midi.id] as MidiClip).notes[midiNote.id].id = 'different-note-id';
    expect(() => validateProjectIntegrity(mismatchedIdentity)).toThrow(/invalid note order/i);

    const noteMutations: Array<(value: MidiNote) => void> = [
      (value) => { value.startTick = -1; },
      (value) => { value.durationTicks = 0; },
      (value) => { value.pitch = 128; },
      (value) => { value.velocity = 1.1; },
      (value) => { value.releaseVelocity = -0.1; },
      (value) => { value.channel = 16; },
      (value) => { value.probability = 1.1; },
    ];
    for (const mutate of noteMutations) {
      const invalid = structuredClone(project);
      mutate((invalid.clips[midi.id] as MidiClip).notes[midiNote.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/MIDI note .* invalid timing or values/i);
    }

    const controlMutations: Array<(value: MidiControlEvent) => void> = [
      (value) => { value.tick = -1; },
      (value) => { value.controller = 128; },
      (value) => { value.value = 1.1; },
      (value) => { value.channel = 16; },
    ];
    for (const mutate of controlMutations) {
      const invalid = structuredClone(project);
      mutate((invalid.clips[midi.id] as MidiClip).controls[midiControl.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/MIDI control .* invalid timing or values/i);
    }

    const bendMutations: Array<(value: MidiPitchBendEvent) => void> = [
      (value) => { value.tick = -1; },
      (value) => { value.value = 1.1; },
      (value) => { value.channel = 16; },
    ];
    for (const mutate of bendMutations) {
      const invalid = structuredClone(project);
      mutate((invalid.clips[midi.id] as MidiClip).pitchBends[pitchBend.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/MIDI pitch bend .* invalid timing or values/i);
    }

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'midi.note.update', clipId: midi.id, noteId: midiNote.id, changes: { pitch: 128 }, expectedRevision: project.clips[midi.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/MIDI note .* invalid timing or values/i);
  });
});
