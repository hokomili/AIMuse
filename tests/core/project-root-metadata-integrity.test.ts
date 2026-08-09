import { describe, expect, it } from 'vitest';
import {
  applyProjectTransaction,
  createId,
  createProject,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const CREATOR: Actor = {
  id: 'a'.repeat(240), kind: 'agent', name: 'n'.repeat(100), color: 'c'.repeat(40),
  client: { product: 'p'.repeat(100), model: 'm'.repeat(160), effort: 'e'.repeat(80), taskId: 't'.repeat(240), version: 'v'.repeat(80) },
};
const EDITOR: Actor = { id: 'project-root-editor', kind: 'human', name: 'Project Root Editor', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Project root metadata integrity', createdAt: nowIso(), operations };
}

describe('project root declared metadata integrity', () => {
  it('creates a valid attributed root and preserves creator identity across authenticated transactions', () => {
    const project = createProject('song', 'Project root creation', CREATOR);
    expect(project).toMatchObject({ revision: 0, createdBy: CREATOR, dirty: true });
    expect(project.id.length).toBeGreaterThanOrEqual(1);
    expect(project.id.length).toBeLessThanOrEqual(240);
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(project.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(project.projectPath).toBeUndefined();
    expect(project.createdBy).not.toBe(CREATOR);
    validateProjectIntegrity(project);

    const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'project.rename', name: 'Attributed root edit' }], EDITOR), { authenticatedActor: EDITOR }).project;
    expect(committed.createdBy).toEqual(CREATOR);
    expect(committed.activity.at(-1)?.actor).toEqual(EDITOR);
    expect(committed.revision).toBe(1);
    expect(committed.dirty).toBe(true);
    validateProjectIntegrity(committed);

    const invalidCreators: Actor[] = [
      { ...CREATOR, id: '' },
      { ...CREATOR, kind: 'service' as Actor['kind'] },
      { ...CREATOR, name: '' },
      { ...CREATOR, color: '' },
      { ...CREATOR, client: { product: 'p'.repeat(101) } },
    ];
    for (const actor of invalidCreators) expect(() => createProject('song', 'Rejected creator', actor)).toThrow(/Project creator/i);
  });

  it('accepts exact root boundaries and rejects malformed stored metadata without inferring relationships', () => {
    const project = createProject('song', 'Project root values');
    const original = structuredClone(project);

    const acceptedCases: Array<Partial<AIMuseProject>> = [
      { id: 'i' },
      { id: 'i'.repeat(240) },
      { revision: 0 },
      { revision: 42 },
      { createdAt: '2026-08-08T03:04:05Z', updatedAt: '2026-08-07T03:04:05.123456Z' },
      { createdBy: CREATOR },
      { dirty: false },
      { dirty: true },
      { projectPath: '' },
      { projectPath: 'p'.repeat(32_000) },
      { projectPath: undefined },
    ];
    for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      Object.assign(accepted, changes);
      validateProjectIntegrity(accepted);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { id: '' }, message: /invalid ID/i },
      { changes: { id: 'i'.repeat(241) }, message: /invalid ID/i },
      { changes: { id: 42 }, message: /invalid ID/i },
      { changes: { revision: -1 }, message: /invalid revision/i },
      { changes: { revision: 0.5 }, message: /invalid revision/i },
      { changes: { revision: Number.NaN }, message: /invalid revision/i },
      { changes: { createdAt: '2026-02-30T00:00:00Z' }, message: /invalid creation timestamp/i },
      { changes: { createdAt: '2026-08-07T00:00:00+00:00' }, message: /invalid creation timestamp/i },
      { changes: { createdAt: 42 }, message: /invalid creation timestamp/i },
      { changes: { updatedAt: '2026-13-01T00:00:00Z' }, message: /invalid update timestamp/i },
      { changes: { updatedAt: 'not-a-timestamp' }, message: /invalid update timestamp/i },
      { changes: { updatedAt: 42 }, message: /invalid update timestamp/i },
      { changes: { createdBy: { ...CREATOR, id: '' } }, message: /creator .* invalid ID/i },
      { changes: { createdBy: { ...CREATOR, kind: 'service' } }, message: /invalid kind/i },
      { changes: { createdBy: { ...CREATOR, name: 'n'.repeat(101) } }, message: /invalid name/i },
      { changes: { createdBy: { ...CREATOR, color: 'c'.repeat(41) } }, message: /invalid color/i },
      { changes: { createdBy: { ...CREATOR, client: { taskId: 't'.repeat(241) } } }, message: /invalid client metadata/i },
      { changes: { dirty: 'true' }, message: /invalid dirty value/i },
      { changes: { dirty: 1 }, message: /invalid dirty value/i },
      { changes: { projectPath: 'p'.repeat(32_001) }, message: /invalid project path/i },
      { changes: { projectPath: 42 }, message: /invalid project path/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid, changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
    }

    expect(project).toEqual(original);
  });
});
