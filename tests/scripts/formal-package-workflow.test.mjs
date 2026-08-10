import { describe, expect, it } from 'vitest';
import { formalWorkflowStages, runFormalPackageWorkflow } from '../../scripts/formal-package-workflow.mjs';

const inputs = { gitHead: 'a', gitBranch: 'branch', indexSha256: 'b', dirtyStatusSha256: 'c', workspaceInputsSha256: 'd', workspaceInputFiles: 1 };

describe('formal package workflow ordering', () => {
  it('packages once, freezes before verification, and rehashes after Level 2 E2E', async () => {
    const commands = [];
    let verifyCalls = 0;
    const manifest = { subject: { identitySha256: 'IDENTITY' } };
    const formalRunRoot = `${process.cwd()}/test-results/luna-high/fake-run`;
    const requestedManifest = `${formalRunRoot}/package-subject.json`;
    const result = await runFormalPackageWorkflow({
      level: 2,
      workspace: process.cwd(),
      environment: {
        ...process.env,
        AIMUSE_FORMAL_RUN_ROOT: formalRunRoot,
        AIMUSE_PACKAGE_SUBJECT_MANIFEST: requestedManifest,
        AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: 'F'.repeat(64),
      },
      runCommand: async (command, arguments_, options) => { commands.push({ command, arguments_, environment: options.env }); },
      captureInputs: async () => inputs,
      createSubject: async ({ manifestPath, sourceInputs }) => ({ manifestPath, manifestSha256: 'A'.repeat(64), manifest: { ...manifest, inputs: sourceInputs } }),
      verifySubject: async () => { verifyCalls += 1; },
    });
    expect(commands.filter(({ arguments_ }) => arguments_.join(' ') === 'run package:artifact')).toHaveLength(1);
    expect(commands.some(({ arguments_ }) => arguments_.join(' ') === 'run package')).toBe(false);
    expect(commands.some(({ arguments_ }) => arguments_.join(' ') === 'run test:e2e')).toBe(false);
    for (const command of commands.slice(0, 4)) {
      expect(command.environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST).toBeUndefined();
      expect(command.environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256).toBeUndefined();
    }
    const e2e = commands.find(({ arguments_ }) => arguments_.join(' ') === 'run test:e2e:only');
    expect(e2e.environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST).toBe(requestedManifest);
    expect(e2e.environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256).toBe('A'.repeat(64));
    expect(e2e.environment.AIMUSE_FORMAL_RUN_ROOT.endsWith('/test-results/luna-high/fake-run')).toBe(true);
    expect(verifyCalls).toBe(4);
    expect(result.inputs).toBe(inputs);
  });

  it('keeps Level 1 free of packaged E2E and exposes deterministic stages', () => {
    const stages = formalWorkflowStages(1);
    expect(stages.filter((stage) => stage === 'package-artifact-once')).toHaveLength(1);
    expect(stages).not.toContain('packaged-e2e-from-subject');
    expect(() => formalWorkflowStages(3)).toThrow(/level must be 1 or 2/u);
  });
});
