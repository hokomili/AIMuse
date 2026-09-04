import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORMAL_RUN_ROOT_ENV,
  PACKAGED_E2E_OUTPUT_ENV,
  RENDERER_OUTPUT_ENV,
  packagedE2ePathsOverlap,
  resolvePackagedE2eOutputSelection,
  resolveRendererOutputSelection,
} from '../../scripts/playwright-output.mjs';

const createdRoots = [];

async function temporaryWorkspace() {
  const temporaryParent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryParent, 'aimuse-playwright-output-')));
  createdRoots.push(root);
  await mkdir(join(root, 'test-results', 'playwright'), { recursive: true });
  return root;
}

afterEach(async () => {
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('packaged Playwright output isolation', () => {
  it('selects narrow sibling targets for test artifacts and the HTML reporter', async () => {
    const workspace = await temporaryWorkspace();
    const selection = resolvePackagedE2eOutputSelection({ workspace, environment: {} });

    expect(selection.outputDir).toBe(join(workspace, 'test-results', 'playwright', 'packaged-e2e'));
    expect(selection.htmlReportDir).toBe(`${selection.outputDir}-html-report`);
    expect(selection.testResultsRoot).toBe(join(workspace, 'test-results'));
  });

  it('keeps formal renderer artifacts inside the protected run root', async () => {
    const workspace = await temporaryWorkspace();
    const formalRunRoot = join(workspace, 'test-results', 'luna-high', 'renderer-run');
    await mkdir(formalRunRoot, { recursive: true });
    const selection = resolveRendererOutputSelection({
      workspace,
      environment: { [FORMAL_RUN_ROOT_ENV]: formalRunRoot },
    });
    expect(selection.outputDir).toBe(join(formalRunRoot, 'renderer-playwright'));
    expect(() => resolveRendererOutputSelection({
      workspace,
      environment: {
        [FORMAL_RUN_ROOT_ENV]: formalRunRoot,
        [RENDERER_OUTPUT_ENV]: join(workspace, 'test-results', 'renderer-outside'),
      },
    })).toThrow(/strict descendant/u);
  });

  it('uses case-insensitive containment and overlap semantics on Windows', () => {
    const output = 'C:\\AIMuse\\test-results\\playwright\\Run-01';
    expect(packagedE2ePathsOverlap(output, 'c:\\aimuse\\TEST-RESULTS\\PLAYWRIGHT\\run-01', 'win32')).toBe(true);
    expect(packagedE2ePathsOverlap(output, 'c:\\aimuse\\test-results\\playwright\\RUN-01\\nested', 'win32')).toBe(true);
    expect(packagedE2ePathsOverlap(output, 'C:\\AIMuse\\test-results\\luna-high\\run-01', 'win32')).toBe(false);
  });

  it('fails closed for broad targets and any overlap with a declared formal root or its parent', async () => {
    const workspace = await temporaryWorkspace();
    const testResults = join(workspace, 'test-results');
    const packagedRoot = join(testResults, 'playwright');
    const formalParent = join(packagedRoot, 'protected-certification');
    const formalRoot = join(formalParent, '20260809T150538Z-macos-level2');
    await mkdir(formalRoot, { recursive: true });

    for (const outputDir of [workspace, testResults, packagedRoot]) {
      expect(() => resolvePackagedE2eOutputSelection({
        workspace,
        environment: { [PACKAGED_E2E_OUTPUT_ENV]: outputDir },
      })).toThrow(/strict descendant|must not equal/u);
    }
    for (const outputDir of [formalParent, formalRoot, join(formalRoot, 'artifacts')]) {
      expect(() => resolvePackagedE2eOutputSelection({
        workspace,
        environment: {
          [PACKAGED_E2E_OUTPUT_ENV]: outputDir,
          [FORMAL_RUN_ROOT_ENV]: formalRoot,
        },
      })).toThrow('must be disjoint');
    }
    expect(() => resolvePackagedE2eOutputSelection({
      workspace,
      environment: {
        [PACKAGED_E2E_OUTPUT_ENV]: 'test-results/playwright/relative',
        [FORMAL_RUN_ROOT_ENV]: formalRoot,
      },
    })).toThrow('must be an absolute path');
  });

  it('rejects symbolic-link and non-canonical aliases before Playwright can clean them', async () => {
    const workspace = await temporaryWorkspace();
    const external = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'aimuse-playwright-external-')));
    createdRoots.push(external);
    const alias = join(workspace, 'test-results', 'playwright', 'alias');
    await symlink(external, alias, 'dir');

    expect(() => resolvePackagedE2eOutputSelection({
      workspace,
      environment: { [PACKAGED_E2E_OUTPUT_ENV]: join(alias, 'artifacts') },
    })).toThrow(/canonical path|symbolic link/u);
  });

  it('preserves sibling evidence and a nested luna-high run through the real Playwright selection and cleanup path', async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const fixtureParent = await mkdtemp(join(repositoryRoot, 'test-results', 'playwright-isolation-fixture-'));
    createdRoots.push(fixtureParent);
    const siblingEvidence = join(fixtureParent, 'prior-evidence', 'immutable-preflight.json');
    const formalRunRoot = join(fixtureParent, 'luna-high', '20260809T150538Z-macos-level2');
    const formalLog = join(formalRunRoot, 'automation.log');
    const uniqueName = `cleanup-${process.pid}-${Date.now()}`;
    const outputDir = join(repositoryRoot, 'test-results', 'playwright', uniqueName);
    createdRoots.push(outputDir, `${outputDir}-html-report`);
    await mkdir(dirname(siblingEvidence), { recursive: true });
    await mkdir(formalRunRoot, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(siblingEvidence, 'immutable sibling evidence\n');
    await writeFile(formalLog, 'immutable formal automation log\n');
    await writeFile(join(outputDir, 'stale-playwright-artifact.txt'), 'must be cleaned\n');

    const result = spawnSync(process.execPath, [
      resolve(repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--config=playwright.config.ts',
      '--grep=__AIMUSE_INTENTIONALLY_NO_MATCHING_PACKAGED_E2E__',
      '--pass-with-no-tests',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        [PACKAGED_E2E_OUTPUT_ENV]: outputDir,
        [FORMAL_RUN_ROOT_ENV]: formalRunRoot,
      },
      shell: false,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await readFile(siblingEvidence, 'utf8')).toBe('immutable sibling evidence\n');
    expect(await readFile(formalLog, 'utf8')).toBe('immutable formal automation log\n');
    await expect(readFile(join(outputDir, 'stale-playwright-artifact.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(`${outputDir}-html-report/index.html`, 'utf8')).toContain('<!DOCTYPE html>');
  });
});
