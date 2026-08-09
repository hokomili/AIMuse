import { readFile, readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPortablePaths, portablePathKey, relativeImportCandidates } from './portability-lib.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(workspace, 'scripts', 'initial-snapshot-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const failures = [];
const files = [];

function absolute(relativePath) {
  return resolve(workspace, ...relativePath.split('/'));
}

async function collectTree(relativeRoot) {
  async function visit(relativeDirectory) {
    const entries = await readdir(absolute(relativeDirectory), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        failures.push(`${relativePath}: symbolic links are not allowed in the initial portable snapshot`);
      } else if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        failures.push(`${relativePath}: unsupported filesystem object type`);
      }
    }
  }
  await visit(relativeRoot);
}

for (const path of manifest.rootFiles) files.push(path);
for (const path of manifest.files) files.push(path);
for (const path of manifest.trees) await collectTree(path);

const uniqueFiles = [...new Set(files)].sort((left, right) => left.localeCompare(right, 'en'));
failures.push(...auditPortablePaths(uniqueFiles));

const exactFiles = new Set(uniqueFiles);
const normalizedFiles = new Map(uniqueFiles.map((path) => [portablePathKey(path), path]));
let relativeImportsChecked = 0;
const sourceExtension = /\.(?:[cm]?js|[jt]sx?)$/u;
const importPattern = /(?:from\s*|import\s*\(|import\s*)["'](\.\.?\/[^"']+)["']/gu;
for (const importer of uniqueFiles.filter((path) => sourceExtension.test(path))) {
  const source = await readFile(absolute(importer), 'utf8');
  for (const match of source.matchAll(importPattern)) {
    relativeImportsChecked += 1;
    const candidates = relativeImportCandidates(importer, match[1]);
    if (candidates.some((candidate) => exactFiles.has(candidate))) continue;
    const mismatched = candidates.map((candidate) => normalizedFiles.get(portablePathKey(candidate))).find(Boolean);
    if (mismatched) failures.push(`${importer}: import ${match[1]} differs in case or Unicode form from ${mismatched}`);
    else failures.push(`${importer}: import ${match[1]} has no target inside the snapshot manifest`);
  }
}

const ignore = await readFile(resolve(workspace, '.gitignore'), 'utf8');
for (const name of manifest.neverTrackRootNames) {
  const expected = `/${name}/`;
  const fileExpected = `/${name}`;
  if (!ignore.split(/\r?\n/u).includes(expected) && !ignore.split(/\r?\n/u).includes(fileExpected)) {
    failures.push(`.gitignore does not contain an anchored never-track rule for ${name}`);
  }
}
const attributes = await readFile(resolve(workspace, '.gitattributes'), 'utf8');
if (!attributes.split(/\r?\n/u).includes('* text=auto')) failures.push('.gitattributes does not declare text=auto');
const nvm = (await readFile(resolve(workspace, '.nvmrc'), 'utf8')).trim();
const packageJson = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
if (nvm !== '24' || packageJson.engines?.node !== '>=24 <25') failures.push('Node 24 lock is inconsistent across .nvmrc and package.json');

const result = {
  status: failures.length ? 'FAIL' : 'PASS',
  manifestVersion: manifest.version,
  filesChecked: uniqueFiles.length,
  relativeImportsChecked,
  safeTrees: manifest.trees,
  rootWasEnumerated: false,
  protectedNamesWereAccessed: false,
  failures,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
