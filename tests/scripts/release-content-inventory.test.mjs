import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryContentTree } from '../../scripts/release-content-inventory.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('release content-tree inventory', () => {
  it('binds implementation bytes, modes, internal links, and explicitly declared external trees', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'aimuse-content-inventory-')));
    roots.push(workspace);
    const tree = join(workspace, 'node_modules');
    const external = join(workspace, 'packages', 'core');
    await mkdir(join(tree, 'tool', 'lib'), { recursive: true });
    await mkdir(join(tree, '.bin'), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(tree, 'tool', 'lib', 'cli.js'), 'implementation\n');
    await writeFile(join(external, 'package.json'), '{"name":"@aimuse/core"}\n');
    await symlink('../tool/lib/cli.js', join(tree, '.bin', 'tool'));
    await mkdir(join(tree, '@aimuse'), { recursive: true });
    await symlink('../../packages/core', join(tree, '@aimuse', 'core'));

    const first = await inventoryContentTree({ role: 'installedDependencies', root: tree, allowedExternalRoots: [external] });
    const second = await inventoryContentTree({ role: 'installedDependencies', root: tree, allowedExternalRoots: [external] });
    expect(second).toEqual(first);
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tool/lib/cli.js', type: 'file' }),
      expect.objectContaining({ path: '.bin/tool', type: 'symlink', targetScope: 'content-tree' }),
      expect.objectContaining({ path: '@aimuse/core', type: 'symlink', targetScope: 'declared-external-tree' }),
    ]));

    await writeFile(join(tree, 'tool', 'lib', 'cli.js'), 'changed implementation\n');
    const changed = await inventoryContentTree({ role: 'installedDependencies', root: tree, allowedExternalRoots: [external] });
    expect(changed.entriesSha256).not.toBe(first.entriesSha256);
  });

  it('rejects a link to implementation bytes outside every declared content tree', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'aimuse-content-inventory-unbound-')));
    roots.push(workspace);
    const tree = join(workspace, 'tree');
    const outside = join(workspace, 'outside');
    await mkdir(tree);
    await mkdir(outside);
    await writeFile(join(outside, 'loader.js'), 'unbound\n');
    await symlink('../outside/loader.js', join(tree, 'loader.js'));
    await expect(inventoryContentTree({ role: 'tooling', root: tree })).rejects.toThrow(/unbound symbolic link/u);
  });
});
