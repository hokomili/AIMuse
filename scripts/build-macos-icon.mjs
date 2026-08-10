import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

if (process.platform !== 'darwin') throw new Error('AIMuse .icns generation requires macOS sips and iconutil.');

const source = resolve('build', 'icon.svg');
const destination = resolve('build', 'icon.icns');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'aimuse-icon-'));
const iconset = join(temporaryRoot, 'AIMuse.iconset');
const raster = join(temporaryRoot, 'icon.svg.png');
const sizes = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
}

try {
  await mkdir(iconset);
  run('qlmanage', ['-t', '-s', '1024', '-o', temporaryRoot, source]);
  for (const [name, size] of sizes) run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), raster, '--out', join(iconset, String(name))]);
  run('iconutil', ['-c', 'icns', iconset, '-o', destination]);
  process.stdout.write(`${destination}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
