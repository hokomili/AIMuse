import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = join(process.cwd(), 'out');
async function files(directory) {
  return (await readdir(directory, { withFileTypes: true })).flatMap((entry) => entry.name === 'SHA256SUMS.txt' ? [] : entry.isDirectory() ? [files(join(directory, entry.name))] : [join(directory, entry.name)]);
}
async function flatten(values) {
  const result = [];
  for (const value of values) result.push(...(value instanceof Promise ? await flatten(await value) : Array.isArray(value) ? await flatten(value) : [value]));
  return result;
}
const makeRoot = join(root, 'make');
const artifacts = (await flatten(await files(makeRoot))).sort();
if (!artifacts.length) throw new Error(`No release artifacts exist below ${makeRoot}. Run npm run make first.`);
const lines = [];
for (const path of artifacts) lines.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(root, path).replaceAll('\\', '/')}`);
await writeFile(join(root, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');

