import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';
import { readProjectFolder, saveProjectFolder } from '../../src/main/persistence';

const AGENT: Actor = { id: 'agent-qa07-hierarchy-cycle', kind: 'agent', name: 'QA-07 Hierarchy Agent', color: '#22d3ee' };

function transaction(projectId: string, operations: ProjectOperation[]): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor: AGENT, label: 'QA-07 track hierarchy cycle', createdAt: nowIso(), operations };
}

function hierarchyProject(): { project: AIMuseProject; parent: Track; nested: Track } {
  const base = createProject('song', 'QA-07 hierarchy cycle', AGENT);
  const parent = createTrack('folder', 'Parent folder', '#14b8a6', AGENT);
  const nested = createTrack('folder', 'Nested folder', '#a78bfa', AGENT);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: parent, index: 0 },
    { kind: 'track.add', track: nested, parentId: parent.id, index: 0 },
  ]), { authenticatedActor: AGENT }).project;
  return { project, parent, nested };
}

function withHierarchyCycle(project: AIMuseProject, parentId: string, nestedId: string): AIMuseProject {
  const cyclic = structuredClone(project);
  cyclic.trackOrder = cyclic.trackOrder.filter((id) => id !== parentId);
  cyclic.tracks[parentId].parentId = nestedId;
  cyclic.tracks[nestedId].childTrackIds.push(parentId);
  return cyclic;
}

describe('QA-07 track-hierarchy cycle corruption', () => {
  let root: string;

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-qa07-hierarchy-cycle-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('rejects a schema-valid reciprocal stored cycle without mutating or repairing the candidate', () => {
    const { project, parent, nested } = hierarchyProject();
    const cyclic = withHierarchyCycle(project, parent.id, nested.id);
    const before = structuredClone(cyclic);

    expect(() => validateProject(cyclic)).toThrow(/track hierarchy contains a cycle/i);
    expect(() => validateProjectIntegrity(cyclic)).toThrow(/track hierarchy contains a cycle/i);
    expect(cyclic).toEqual(before);
  });

  it('rejects a descendant-parent move before mutation and leaves later valid work eligible', () => {
    const { project, parent, nested } = hierarchyProject();
    const before = structuredClone(project);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'track.move', trackId: parent.id, parentId: nested.id, index: 0,
      expectedRevision: project.tracks[parent.id].revision,
    }]), { authenticatedActor: AGENT })).toThrow(/folder move would create a cycle/i);
    expect(project).toEqual(before);

    const valid = applyProjectTransaction(project, transaction(project.id, [{
      kind: 'track.move', trackId: nested.id, index: 1,
      expectedRevision: project.tracks[nested.id].revision,
    }]), { authenticatedActor: AGENT });
    expect(valid.project.tracks[nested.id].parentId).toBeUndefined();
    expect(valid.project.revision).toBe(project.revision + 1);
    validateProjectIntegrity(valid.project);
  });

  it('rejects a persisted cycle on folder read, preserves corrupt bytes, and can reopen restored valid bytes', async () => {
    const { project, parent, nested } = hierarchyProject();
    const saved = await saveProjectFolder(project, join(root, 'Hierarchy.aimuse'), { appVersion: 'test' });
    const projectFile = join(saved.projectPath, 'project.json');
    const originalText = await readFile(projectFile, 'utf8');
    const cyclic = withHierarchyCycle(JSON.parse(originalText) as AIMuseProject, parent.id, nested.id);
    const cyclicText = `${JSON.stringify(cyclic, null, 2)}\n`;
    await writeFile(projectFile, cyclicText);

    await expect(readProjectFolder(saved.projectPath)).rejects.toThrow(/track hierarchy contains a cycle/i);
    expect(await readFile(projectFile, 'utf8')).toBe(cyclicText);

    await writeFile(projectFile, originalText);
    await expect(readProjectFolder(saved.projectPath)).resolves.toMatchObject({ project: { id: project.id, name: project.name } });
  });
});
