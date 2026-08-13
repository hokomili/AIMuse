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
  type Device,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-device-declared', kind: 'agent', name: 'Device Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-device-declared', kind: 'human', name: 'Device Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Device declared integrity', createdAt: nowIso(), operations };
}

function device(trackId: string, overrides: Record<string, unknown> = {}): Device {
  return {
    ...entityBase('device', AGENT), trackId, format: 'builtin', builtinKind: 'utility', pluginId: 'fixture.plugin',
    pluginVersion: '1.0.0', pluginHash: 'fixture-hash', name: 'Fixture Utility', vendor: 'Fixture Vendor',
    bypassed: false, degraded: false, latencySamples: 0,
    parameters: { gain: { id: 'gain', name: 'Gain', value: 0, defaultValue: 0, min: -1, max: 1, automatable: true } },
    ...overrides,
  } as Device;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function populatedProject(): { project: AIMuseProject; sourceTrack: Track; destinationTrack: Track; routedDevice: Device } {
  const base = createProject('song', 'Device declared values', AGENT);
  const sourceTrack = { ...createTrack('instrument', 'Source', '#14b8a6', AGENT), id: 't' };
  const destinationTrack = { ...createTrack('aux', 'Destination', '#a78bfa', AGENT), id: 'u'.repeat(240) };
  const routedDevice = device(sourceTrack.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: sourceTrack },
    { kind: 'track.add', track: destinationTrack },
    { kind: 'device.add', device: routedDevice },
  ]), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, destinationTrack, routedDevice };
}

function assignStoredDevice(project: AIMuseProject, deviceId: string, changes: Record<string, unknown>): void {
  const value = project.devices[deviceId];
  const nextTrackId = changes.trackId;
  if (Object.prototype.hasOwnProperty.call(changes, 'trackId') && nextTrackId !== value.trackId) {
    project.tracks[value.trackId].deviceIds = project.tracks[value.trackId].deviceIds.filter((id) => id !== value.id);
    if (typeof nextTrackId === 'string' && project.tracks[nextTrackId]) project.tracks[nextTrackId].deviceIds.push(value.id);
  }
  Object.assign(value as unknown as Record<string, unknown>, changes);
}

describe('device immutable declared-value integrity', () => {
  it('preserves exact boundaries, schema-permitted independent descriptors, attribution and semantic inverses', () => {
    const { project, sourceTrack } = populatedProject();
    const before = project;
    const boundary = device(sourceTrack.id, {
      format: 'missing', builtinKind: 'analyzer', pluginId: 'i'.repeat(500), pluginVersion: 'v'.repeat(100),
      pluginHash: 'h'.repeat(128), vendor: 'v'.repeat(500),
    });

    const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: boundary }]), { authenticatedActor: AGENT });
    expect(() => validateProject(committed.project)).not.toThrow();
    validateProjectIntegrity(committed.project);
    expect(committed.project.devices[boundary.id]).toMatchObject({
      trackId: sourceTrack.id, format: 'missing', builtinKind: 'analyzer', pluginId: 'i'.repeat(500),
      pluginVersion: 'v'.repeat(100), pluginHash: 'h'.repeat(128), vendor: 'v'.repeat(500),
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id,
    });

    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo device registration', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(before));
  });

  it('accepts declared values and rejects malformed stored, incoming, existing-target and cascade-cleanup descriptors', () => {
    const { project, sourceTrack, destinationTrack, routedDevice } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const acceptedCases: Array<Record<string, unknown>> = [
      { trackId: destinationTrack.id },
      { format: 'builtin' }, { format: 'vst3' }, { format: 'clap' }, { format: 'missing' },
      ...['sampler', 'drum-rack', 'subtractive-synth', 'utility', 'eq', 'compressor', 'gate', 'saturator', 'chorus', 'delay', 'reverb', 'limiter', 'analyzer'].map((builtinKind) => ({ builtinKind })),
      { builtinKind: undefined },
      { pluginId: '' }, { pluginId: 'i'.repeat(500) }, { pluginId: undefined },
      { pluginVersion: '' }, { pluginVersion: 'v'.repeat(100) }, { pluginVersion: undefined },
      { pluginHash: '' }, { pluginHash: 'not-a-digest' }, { pluginHash: 'h'.repeat(128) }, { pluginHash: undefined },
      { vendor: '' }, { vendor: 'v'.repeat(500) }, { vendor: undefined },
    ];
    for (const changes of acceptedCases) {
      const stored = structuredClone(project);
      assignStoredDevice(stored, routedDevice.id, changes);
      expect(() => validateProject(stored)).not.toThrow();
      validateProjectIntegrity(stored);

      const incoming = device(sourceTrack.id, changes);
      const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: incoming }]), { authenticatedActor: AGENT });
      validateProjectIntegrity(committed.project);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { trackId: '' }, message: /invalid track ID/i },
      { changes: { trackId: 't'.repeat(241) }, message: /invalid track ID/i },
      { changes: { trackId: 42 }, message: /invalid track ID/i },
      { changes: { trackId: undefined }, message: /invalid track ID/i },
      { changes: { format: 'au' }, message: /invalid format/i },
      { changes: { format: 42 }, message: /invalid format/i },
      { changes: { format: undefined }, message: /invalid format/i },
      { changes: { builtinKind: 'unknown' }, message: /invalid built-in kind/i },
      { changes: { builtinKind: 42 }, message: /invalid built-in kind/i },
      { changes: { pluginId: 'i'.repeat(501) }, message: /invalid plug-in ID/i },
      { changes: { pluginId: 42 }, message: /invalid plug-in ID/i },
      { changes: { pluginVersion: 'v'.repeat(101) }, message: /invalid plug-in version/i },
      { changes: { pluginVersion: 42 }, message: /invalid plug-in version/i },
      { changes: { pluginHash: 'h'.repeat(129) }, message: /invalid plug-in hash/i },
      { changes: { pluginHash: 42 }, message: /invalid plug-in hash/i },
      { changes: { vendor: 'v'.repeat(501) }, message: /invalid vendor/i },
      { changes: { vendor: 42 }, message: /invalid vendor/i },
    ];
    for (const { changes, message } of invalidCases) {
      const stored = structuredClone(project);
      assignStoredDevice(stored, routedDevice.id, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incoming = device(sourceTrack.id, changes);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: incoming }]), { authenticatedActor: AGENT })).toThrow(message);
    }

    const corruptedTargetOperations: ProjectOperation[] = [
      { kind: 'device.update', deviceId: routedDevice.id, changes: { name: 'Reviewed device' } },
      { kind: 'device.move', deviceId: routedDevice.id, trackId: destinationTrack.id, index: 0 },
      { kind: 'device.parameter.set', deviceId: routedDevice.id, parameterId: 'gain', value: 0.5 },
      { kind: 'device.delete', deviceId: routedDevice.id },
      { kind: 'track.delete', trackId: sourceTrack.id, cascade: true },
    ];
    for (const operation of corruptedTargetOperations) {
      const corrupted = structuredClone(project);
      (corrupted.devices[routedDevice.id] as unknown as { format: unknown }).format = 'au';
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid format/i);
      expect(corrupted).toEqual(before);
    }
    expect(project).toEqual(original);
  });
});
