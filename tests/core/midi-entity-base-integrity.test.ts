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
  type AIMuseProject,
  type EntityBase,
  type MidiClip,
  type MidiControlEvent,
  type MidiNote,
  type MidiPitchBendEvent,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-midi-entity-base', kind: 'agent', name: 'MIDI Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-midi-entity-base', kind: 'human', name: 'MIDI Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'MIDI entity metadata integrity', createdAt: nowIso(), operations };
}

function clip(trackId: string, name = 'MIDI EntityBase fixture'): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name, color: '#8b5cf6', startTick: 0, durationTicks: 1_920,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function note(startTick = 120, pitch = 60): MidiNote {
  return { ...entityBase('note', AGENT), startTick, durationTicks: 240, pitch, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
}

function control(tick = 240, controller = 1): MidiControlEvent {
  return { ...entityBase('control', AGENT), tick, controller, value: 0.75, channel: 0 };
}

function bend(tick = 360, value = 0.5): MidiPitchBendEvent {
  return { ...entityBase('bend', AGENT), tick, value, channel: 0 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo MIDI entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; trackId: string; midi: MidiClip; midiNote: MidiNote; midiControl: MidiControlEvent; pitchBend: MidiPitchBendEvent } {
  const base = createProject('song', 'MIDI EntityBase values', AGENT);
  const trackId = base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!;
  const midi = clip(trackId);
  const midiNote = note();
  const midiControl = control();
  const pitchBend = bend();
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'clip.add', clip: midi },
    { kind: 'midi.note.add', clipId: midi.id, note: midiNote },
    { kind: 'midi.control.add', clipId: midi.id, event: midiControl },
    { kind: 'midi.pitch-bend.add', clipId: midi.id, event: pitchBend },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, trackId, midi, midiNote, midiControl, pitchBend };
}

type MidiFamily = 'note' | 'control' | 'bend';

function familyRecord(midi: MidiClip, family: MidiFamily, entityId: string): EntityBase {
  if (family === 'note') return midi.notes[entityId];
  if (family === 'control') return midi.controls[entityId];
  return midi.pitchBends[entityId];
}

function assignStoredBoundary(midi: MidiClip, family: MidiFamily, entityId: string, changes: Record<string, unknown>): void {
  const values = family === 'note' ? midi.notes : family === 'control' ? midi.controls : midi.pitchBends;
  const order = family === 'note' ? midi.noteOrder : family === 'control' ? midi.controlOrder : midi.pitchBendOrder;
  const value = values[entityId];
  if (typeof changes.id === 'string' && changes.id !== entityId) {
    delete values[entityId];
    values[changes.id] = value;
    const index = order.indexOf(entityId);
    order[index] = changes.id;
  }
  Object.assign(value, changes);
}

function nestedClipWithInvalidEntity(trackId: string, family: MidiFamily): MidiClip {
  const midi = clip(trackId, `Invalid nested ${family}`);
  if (family === 'note') {
    const value = { ...note(), revision: -1 };
    midi.notes[value.id] = value; midi.noteOrder.push(value.id);
  } else if (family === 'control') {
    const value = { ...control(), revision: -1 };
    midi.controls[value.id] = value; midi.controlOrder.push(value.id);
  } else {
    const value = { ...bend(), revision: -1 };
    midi.pitchBends[value.id] = value; midi.pitchBendOrder.push(value.id);
  }
  return midi;
}

describe('nested MIDI EntityBase declared metadata integrity', () => {
  it('preserves attribution, insertion order and semantic operation inverses', () => {
    let project = createProject('song', 'MIDI EntityBase lifecycles', AGENT);
    const trackId = project.trackOrder.find((id) => project.tracks[id].kind === 'instrument')!;
    const midi = clip(trackId);
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: midi }], AGENT), { authenticatedActor: AGENT }).project;

    const laterNote = note(960, 67); const earlierNote = note(120, 60);
    const laterControl = control(900, 11); const earlierControl = control(100, 1);
    const laterBend = bend(800, 0.5); const earlierBend = bend(50, -0.25);
    project = commitAndVerifyInverse(project, [
      { kind: 'midi.note.add', clipId: midi.id, note: laterNote },
      { kind: 'midi.note.add', clipId: midi.id, note: earlierNote },
      { kind: 'midi.control.add', clipId: midi.id, event: laterControl },
      { kind: 'midi.control.add', clipId: midi.id, event: earlierControl },
      { kind: 'midi.pitch-bend.add', clipId: midi.id, event: laterBend },
      { kind: 'midi.pitch-bend.add', clipId: midi.id, event: earlierBend },
    ]);
    let current = project.clips[midi.id] as MidiClip;
    expect(current.noteOrder).toEqual([laterNote.id, earlierNote.id]);
    expect(current.controlOrder).toEqual([laterControl.id, earlierControl.id]);
    expect(current.pitchBendOrder).toEqual([laterBend.id, earlierBend.id]);
    for (const value of [current.notes[earlierNote.id], current.controls[earlierControl.id], current.pitchBends[earlierBend.id]]) {
      expect(value).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    }

    project = commitAndVerifyInverse(project, [{
      kind: 'midi.note.update', clipId: midi.id, noteId: earlierNote.id, changes: { pitch: 64 }, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.notes[earlierNote.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, pitch: 64 });
    project = commitAndVerifyInverse(project, [{
      kind: 'midi.semantic', clipId: midi.id, noteIds: [earlierNote.id], action: 'transpose', semitones: 1, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.notes[earlierNote.id]).toMatchObject({ revision: 2, createdBy: AGENT.id, updatedBy: REVIEWER.id, pitch: 65 });
    expect(current.noteOrder).toEqual([laterNote.id, earlierNote.id]);

    project = commitAndVerifyInverse(project, [{
      kind: 'midi.pitch-bend.update', clipId: midi.id, eventId: laterBend.id, changes: { tick: 20, value: -0.5, channel: 2 }, expectedRevision: current.revision,
    }], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.pitchBends[laterBend.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, tick: 20 });

    project = commitAndVerifyInverse(project, [
      { kind: 'midi.note.delete', clipId: midi.id, noteId: laterNote.id },
      { kind: 'midi.control.delete', clipId: midi.id, eventId: laterControl.id },
      { kind: 'midi.pitch-bend.delete', clipId: midi.id, eventId: earlierBend.id },
    ], REVIEWER);
    current = project.clips[midi.id] as MidiClip;
    expect(current.noteOrder).toEqual([earlierNote.id]);
    expect(current.controlOrder).toEqual([earlierControl.id]);
    expect(current.pitchBendOrder).toEqual([laterBend.id]);
  });

  it('accepts exact independent boundaries and rejects malformed stored, incoming, semantic-target and preloaded metadata', () => {
    const { project, trackId, midi, midiNote, midiControl, pitchBend } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const families: Array<{ kind: MidiFamily; id: string; orderError: RegExp }> = [
      { kind: 'note', id: midiNote.id, orderError: /invalid note order/i },
      { kind: 'control', id: midiControl.id, orderError: /invalid control order/i },
      { kind: 'bend', id: pitchBend.id, orderError: /invalid pitch-bend order/i },
    ];

    const acceptedCases: Array<Record<string, unknown>> = [
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
    for (const family of families) for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      assignStoredBoundary(accepted.clips[midi.id] as MidiClip, family.kind, family.id, changes);
      validateProjectIntegrity(accepted);
    }

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
    for (const family of families) for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      assignStoredBoundary(invalid.clips[midi.id] as MidiClip, family.kind, family.id, changes);
      const storedMessage = typeof changes.id === 'number' ? family.orderError : message;
      expect(() => validateProjectIntegrity(invalid)).toThrow(storedMessage);

      const operation = family.kind === 'note'
        ? { kind: 'midi.note.add', clipId: midi.id, note: { ...note(), ...changes } }
        : family.kind === 'control'
          ? { kind: 'midi.control.add', clipId: midi.id, event: { ...control(), ...changes } }
          : { kind: 'midi.pitch-bend.add', clipId: midi.id, event: { ...bend(), ...changes } };
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation as unknown as ProjectOperation], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    for (const family of families) {
      const invalidNested = nestedClipWithInvalidEntity(trackId, family.kind);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: invalidNested }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid entity revision/i);
    }

    const invalidNoteOperations: ProjectOperation[] = [
      { kind: 'midi.note.update', clipId: midi.id, noteId: midiNote.id, changes: { pitch: 61 } },
      { kind: 'midi.note.delete', clipId: midi.id, noteId: midiNote.id },
      { kind: 'midi.semantic', clipId: midi.id, noteIds: [midiNote.id], action: 'transpose', semitones: 1 },
    ];
    for (const operation of invalidNoteOperations) {
      const invalid = structuredClone(project); const current = invalid.clips[midi.id] as MidiClip;
      current.notes[midiNote.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidControl = structuredClone(project); const controlClip = invalidControl.clips[midi.id] as MidiClip;
    controlClip.controls[midiControl.id].revision = -1;
    expect(() => applyProjectTransaction(invalidControl, transaction(invalidControl.id, [{ kind: 'midi.control.delete', clipId: midi.id, eventId: midiControl.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);

    const invalidBendOperations: ProjectOperation[] = [
      { kind: 'midi.pitch-bend.update', clipId: midi.id, eventId: pitchBend.id, changes: { value: 0 } },
      { kind: 'midi.pitch-bend.delete', clipId: midi.id, eventId: pitchBend.id },
    ];
    for (const operation of invalidBendOperations) {
      const invalid = structuredClone(project); const current = invalid.clips[midi.id] as MidiClip;
      current.pitchBends[pitchBend.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    expect(project).toEqual(original);
    expect(familyRecord(project.clips[midi.id] as MidiClip, 'note', midiNote.id)).toMatchObject({ createdBy: AGENT.id });
  });
});
