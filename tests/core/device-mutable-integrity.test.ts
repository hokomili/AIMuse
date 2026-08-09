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
  type Device,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-device-mutable', kind: 'agent', name: 'Device Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-device-mutable-reviewer', kind: 'agent', name: 'Device Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Device mutable integrity', createdAt: nowIso(), operations };
}

function stateAsset(): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'plugin-state', name: 'State.bin', mimeType: 'application/octet-stream', sha256: 'd'.repeat(64), byteLength: 32,
    storage: 'embedded',
  };
}

function device(trackId: string): Device {
  return {
    ...entityBase('device', AGENT), trackId, format: 'builtin', builtinKind: 'utility', name: 'Mutable Utility', vendor: 'AIMuse',
    bypassed: false, degraded: false, latencySamples: 0,
    parameters: {
      gain: { id: 'gain', name: 'Gain', value: 0, defaultValue: 0, min: -1, max: 1, unit: 'dB', automatable: true },
      mix: { id: 'mix', name: 'Mix', value: 0.5, defaultValue: 0.5, min: 0, max: 1, unit: '%', automatable: false },
    },
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo device mutable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Device mutable values');
  const track = base.tracks[base.trackOrder[0]];
  const state = stateAsset();
  const valueDevice = device(track.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'asset.add', asset: state }, { kind: 'device.add', device: valueDevice },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, track, state, valueDevice };
}

describe('device mutable and parameter descriptor integrity', () => {
  it('preserves ordering, attribution and semantic inverses across device and parameter lifecycles', () => {
    let project = createProject('song', 'Device mutable lifecycles');
    const track = project.tracks[project.trackOrder[0]];
    const state = stateAsset();
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'asset.add', asset: state }], AGENT), { authenticatedActor: AGENT }).project;
    const valueDevice = device(track.id);
    project = commitAndVerifyInverse(project, [{ kind: 'device.add', device: valueDevice }]);
    const order = [...project.tracks[track.id].deviceIds];
    const createdAt = project.devices[valueDevice.id].createdAt;

    project = commitAndVerifyInverse(project, [{
      kind: 'device.update', deviceId: valueDevice.id, expectedRevision: project.devices[valueDevice.id].revision,
      changes: { name: 'D'.repeat(500), bypassed: true, degraded: true, latencySamples: 512, stateAssetId: state.id, presetName: 'P'.repeat(500) },
    }], REVIEWER);
    expect(project.devices[valueDevice.id]).toMatchObject({
      name: 'D'.repeat(500), bypassed: true, degraded: true, latencySamples: 512, stateAssetId: state.id, presetName: 'P'.repeat(500),
      createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.tracks[track.id].deviceIds).toEqual(order);

    project = commitAndVerifyInverse(project, [{
      kind: 'device.parameter.set', deviceId: valueDevice.id, parameterId: 'gain', value: 1,
      expectedRevision: project.devices[valueDevice.id].revision,
    }], REVIEWER);
    expect(project.devices[valueDevice.id]).toMatchObject({ createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id });
    expect(project.devices[valueDevice.id].parameters.gain).toMatchObject({ value: 1, defaultValue: 0, min: -1, max: 1 });
    expect(project.devices[valueDevice.id].parameters.mix).toMatchObject({ value: 0.5, defaultValue: 0.5, min: 0, max: 1 });
    expect(project.tracks[track.id].deviceIds).toEqual(order);

    project = commitAndVerifyInverse(project, [{ kind: 'device.delete', deviceId: valueDevice.id, expectedRevision: project.devices[valueDevice.id].revision }], REVIEWER);
    expect(project.devices[valueDevice.id]).toBeUndefined();
    expect(project.tracks[track.id].deviceIds).toEqual([]);
  });

  it('accepts exact bounds and rejects malformed device values or parameter descriptors before mutation', () => {
    const { project, track, valueDevice } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidDeviceCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { name: '' }, message: /invalid name/i },
      { changes: { name: 'n'.repeat(501) }, message: /invalid name/i },
      { changes: { name: 42 }, message: /invalid name/i },
      { changes: { bypassed: 'yes' }, message: /invalid state flags/i },
      { changes: { degraded: 0 }, message: /invalid state flags/i },
      { changes: { latencySamples: -1 }, message: /invalid latency/i },
      { changes: { latencySamples: 0.5 }, message: /invalid latency/i },
      { changes: { latencySamples: Number.NaN }, message: /invalid latency/i },
      { changes: { stateAssetId: '' }, message: /invalid state asset ID/i },
      { changes: { stateAssetId: 's'.repeat(241) }, message: /invalid state asset ID/i },
      { changes: { presetName: 'p'.repeat(501) }, message: /invalid preset name/i },
      { changes: { presetName: false }, message: /invalid preset name/i },
    ];
    for (const { changes, message } of invalidDeviceCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.devices[valueDevice.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = { kind: 'device.update', deviceId: valueDevice.id, changes, expectedRevision: project.devices[valueDevice.id].revision } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidParameterCases: Array<{ key?: string; changes: Record<string, unknown>; message: RegExp }> = [
      { key: 'other', changes: {}, message: /invalid parameter descriptor/i },
      { changes: { id: '' }, message: /invalid parameter descriptor/i },
      { changes: { id: 'i'.repeat(501) }, message: /invalid parameter descriptor/i },
      { changes: { name: '' }, message: /invalid parameter descriptor/i },
      { changes: { name: 'n'.repeat(501) }, message: /invalid parameter descriptor/i },
      { changes: { unit: 'u'.repeat(81) }, message: /invalid parameter descriptor/i },
      { changes: { automatable: 'yes' }, message: /invalid parameter descriptor/i },
      { changes: { value: Number.NaN }, message: /invalid parameter bounds/i },
      { changes: { value: 2 }, message: /invalid parameter bounds/i },
      { changes: { defaultValue: -2 }, message: /invalid parameter bounds/i },
      { changes: { min: 2 }, message: /invalid parameter bounds/i },
      { changes: { max: Number.NaN }, message: /invalid parameter bounds/i },
    ];
    for (const { key = 'gain', changes, message } of invalidParameterCases) {
      const invalid = structuredClone(project);
      const parameter = { ...invalid.devices[valueDevice.id].parameters.gain, ...changes };
      if (key !== 'gain') delete invalid.devices[valueDevice.id].parameters.gain;
      invalid.devices[valueDevice.id].parameters[key] = parameter;
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = { kind: 'device.parameter.set', deviceId: valueDevice.id, parameterId: key, value: 0 } as ProjectOperation;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    for (const value of [-1, 1]) {
      const result = applyProjectTransaction(project, transaction(project.id, [{
        kind: 'device.parameter.set', deviceId: valueDevice.id, parameterId: 'gain', value,
        expectedRevision: project.devices[valueDevice.id].revision,
      }], REVIEWER), { authenticatedActor: REVIEWER });
      expect(result.project.devices[valueDevice.id].parameters.gain.value).toBe(value);
    }
    for (const value of [-1.000_001, 1.000_001, Number.NaN]) {
      expect(() => applyProjectTransaction(project, transaction(project.id, [{
        kind: 'device.parameter.set', deviceId: valueDevice.id, parameterId: 'gain', value,
        expectedRevision: project.devices[valueDevice.id].revision,
      }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/parameter value is outside/i);
    }
    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'device.parameter.set', deviceId: valueDevice.id, parameterId: 'missing', value: 0,
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/parameter does not exist/i);

    const invalidAdd = device(track.id);
    invalidAdd.parameters.gain.defaultValue = 2;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: invalidAdd }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid parameter bounds/i);
    expect(project).toEqual(original);
  });
});
