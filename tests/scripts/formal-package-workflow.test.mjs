import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formalWorkflowStages, runFormalPackageWorkflow } from '../../scripts/formal-package-workflow.mjs';

const inputs = { gitHead: 'a', gitBranch: 'branch', indexSha256: 'b', dirtyStatusSha256: 'c', workspaceInputsSha256: 'd', workspaceInputFiles: 1 };
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }

describe('formal package workflow ordering', () => {
  it('uses only caller-declared inputs and separately witnessed Level 2 commands', async () => {
    const workspace = process.cwd();
    const suffix = `${process.pid}-${Date.now()}`;
    const formalRunRoot = join(workspace, 'test-results', 'luna-high', `fake-run-${suffix}`);
    const requestedManifest = join(formalRunRoot, 'package-subject.json');
    const declaredPath = join(formalRunRoot, 'declared-release-inputs.json');
    const contractBytes = await readFile(join(workspace, 'scripts', 'formal-release-contract.json'));
    const protectedRoot = { identity: { canonicalPath: formalRunRoot, device: '1', inode: '2' }, owner: 'launching-user', allowedPrincipals: ['launching-user'] };
    const protectedExecutionTemp = { identity: { canonicalPath: `/private/tmp/fake-run-${suffix}`, device: '3', inode: '4' }, owner: 'launching-user', allowedPrincipals: ['launching-user'] };
    const declared = {
      path: declaredPath,
      bytes: Buffer.from('{}'),
      digest: 'D'.repeat(64),
      manifest: {
        schemaVersion: 2,
        kind: 'aimuse-declared-release-inputs',
        acceptanceVerdict: null,
        level: 2,
        sourceInputs: inputs,
        paths: {
          workspace,
          formalRunRoot,
          forgeOutDirectory: join(formalRunRoot, 'package-output'),
          packageSubjectManifest: requestedManifest,
          packagedPlaywrightOutput: join(workspace, 'test-results', 'playwright', `fake-run-${suffix}`),
          executionTemp: protectedExecutionTemp.identity.canonicalPath,
          architecture: 'arm64',
        },
        contract: { path: 'scripts/formal-release-contract.json', bytes: contractBytes.length, sha256: sha256(contractBytes) },
        protectedRunRoot: protectedRoot,
        protectedExecutionTemp,
      },
    };
    const witnessed = [];
    let subjectCreated = false;
    const result = await runFormalPackageWorkflow({
      level: 2,
      workspace,
      environment: {
        AIMUSE_RELEASE_INPUTS_MANIFEST: declaredPath,
        AIMUSE_RELEASE_INPUTS_SHA256: declared.digest,
        AIMUSE_FORMAL_RUN_ROOT: formalRunRoot,
        AIMUSE_FORGE_OUT_DIR: declared.manifest.paths.forgeOutDirectory,
        AIMUSE_PACKAGE_SUBJECT_MANIFEST: requestedManifest,
        AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR: declared.manifest.paths.packagedPlaywrightOutput,
      },
      loadDeclaredInputs: async () => declared,
      captureInputs: async () => inputs,
      createSubject: async ({ manifestPath, sourceInputs }) => {
        subjectCreated = true;
        return { manifestPath, manifestSha256: 'A'.repeat(64), manifest: { inputs: sourceInputs, subject: { identitySha256: 'IDENTITY' } } };
      },
      executeWitness: async ({ stageId, packageSubject }) => {
        witnessed.push({ stageId, packageSubject });
        if (stageId === 'package-artifact-once') expect(subjectCreated).toBe(false);
        if (stageId === 'verify-package-after-freeze') expect(subjectCreated).toBe(true);
      },
      loadWitnessReceipt: async ({ stage }) => ({ stageId: stage.id, path: `execution/${stage.id}.receipt.json`, bytes: 1, sha256: 'E'.repeat(64) }),
      inspectRunRoot: async () => protectedRoot,
      inspectExecutionTemp: async () => protectedExecutionTemp,
      publishArtifact: async (path, bytes) => ({ path, bytes: bytes.length, sha256: 'F'.repeat(64) }),
    });
    expect(witnessed.map(({ stageId }) => stageId)).toEqual(formalWorkflowStages(2));
    expect(witnessed.filter(({ stageId }) => stageId === 'package-artifact-once')).toHaveLength(1);
    expect(witnessed.filter(({ packageSubject }) => packageSubject).map(({ stageId }) => stageId)).toEqual([
      'verify-package-after-freeze', 'packaged-e2e-from-subject', 'verify-package-after-e2e',
    ]);
    expect(result.inputs).toBe(declared.manifest);
    expect(result.observationManifestPath).toBe(join(formalRunRoot, 'automation-observations.json'));
  });

  it('keeps Level 1 free of packaged E2E and derives stages from the stable contract', () => {
    const stages = formalWorkflowStages(1);
    expect(stages.filter((stage) => stage === 'package-artifact-once')).toHaveLength(1);
    expect(stages).not.toContain('packaged-e2e-from-subject');
    expect(() => formalWorkflowStages(3)).toThrow(/level must be 1 or 2/u);
  });
});
