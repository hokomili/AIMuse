import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const records = [];
for (const [location, value] of Object.entries(lock.packages ?? {})) {
  if (!location.includes('node_modules/') || (!value?.name && !location)) continue;
  const name = value.name ?? location.split('node_modules/').at(-1);
  if (!name || !value.version) continue;
  let metadata = value;
  try { metadata = { ...value, ...JSON.parse(await readFile(join(root, location, 'package.json'), 'utf8')) }; } catch { /* Lockfile metadata is the fallback. */ }
  const license = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type ?? 'UNKNOWN';
  records.push({ name, version: value.version, license, repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url });
}
records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const unique = [...new Map(records.map((record) => [`${record.name}@${record.version}`, record])).values()];
const out = join(root, 'out');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'THIRD_PARTY_LICENSES.json'), `${JSON.stringify(unique, null, 2)}\n`, 'utf8');
await writeFile(join(out, 'THIRD_PARTY_LICENSES.md'), `# Third-party dependency licenses\n\nGenerated from the exact release lockfile. Verify UNKNOWN entries and native SDK notices before publishing.\n\n${unique.map((record) => `- **${record.name}@${record.version}** — ${record.license}${record.repository ? ` — ${record.repository}` : ''}`).join('\n')}\n`, 'utf8');

