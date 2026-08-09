import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
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

const AGENT: Actor = { id: 'agent-lyrics', kind: 'agent', name: 'Lyrics Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-lyrics-reviewer', kind: 'agent', name: 'Lyrics Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, lyrics: string, actor: Actor): ProjectTransaction {
  return {
    id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Lyrics integrity', createdAt: nowIso(),
    operations: [{ kind: 'lyrics.set', lyrics }],
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function setAndVerifyInverse(project: AIMuseProject, lyrics: string, actor: Actor): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, lyrics, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo lyrics edit', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  expect(committed.project.activity.at(-1)?.actor.id).toBe(actor.id);
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('lyrics integrity', () => {
  it('keeps exact set, replace and clear lifecycles semantically invertible', () => {
    let project = createProject('song', 'Lyrics lifecycle');
    const draft = '  First line\nSecond line  ';
    project = setAndVerifyInverse(project, draft, AGENT);
    expect(project.lyrics).toBe(draft);

    const revision = 'Revised verse\n\nFinal line';
    project = setAndVerifyInverse(project, revision, REVIEWER);
    expect(project.lyrics).toBe(revision);

    project = setAndVerifyInverse(project, '', REVIEWER);
    expect(project.lyrics).toBe('');
  });

  it('accepts the declared maximum and rejects longer or non-string lyrics without truncation', () => {
    const project = createProject('song', 'Lyrics limits');
    const maximum = 'a'.repeat(200_000);
    const accepted = applyProjectTransaction(project, transaction(project.id, maximum, AGENT), { authenticatedActor: AGENT }).project;
    expect(accepted.lyrics).toBe(maximum);
    expect(project.lyrics).toBe('');
    validateProjectIntegrity(accepted);

    const overlong = 'b'.repeat(200_001);
    expect(() => applyProjectTransaction(project, transaction(project.id, overlong, AGENT), { authenticatedActor: AGENT })).toThrow(/200,000/);
    expect(project.lyrics).toBe('');

    const invalidProject = structuredClone(project);
    invalidProject.lyrics = overlong;
    expect(() => validateProjectIntegrity(invalidProject)).toThrow(/200,000/);

    const nonStringProject = structuredClone(project);
    (nonStringProject as unknown as Record<string, unknown>).lyrics = 42;
    expect(() => validateProjectIntegrity(nonStringProject)).toThrow(/200,000/);
    const invalidOperation = { kind: 'lyrics.set', lyrics: 42 } as unknown as ProjectOperation;
    expect(() => applyProjectTransaction(project, {
      ...transaction(project.id, '', AGENT), operations: [invalidOperation],
    }, { authenticatedActor: AGENT })).toThrow(/200,000/);
  });
});
