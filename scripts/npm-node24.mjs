import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';

function exists(path) { try { accessSync(path); return true; } catch { return false; } }
function nodeMajor(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? Number(result.stdout.trim().replace(/^v/, '').split('.')[0]) : undefined;
}

const nodeCandidates = [
  process.env.AIMUSE_NODE24_EXE,
  process.execPath,
  join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  'C:\\Program Files\\nodejs\\node.exe',
].filter(Boolean).map((candidate) => resolve(candidate));
const node24 = [...new Set(nodeCandidates)].find((candidate) => exists(candidate) && nodeMajor(candidate) === 24);
if (!node24) throw new Error('Node 24.x was not found. Activate .nvmrc or set AIMUSE_NODE24_EXE to an absolute Node 24 executable.');

const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
const npmCandidates = [
  process.env.AIMUSE_NPM_CLI,
  join(dirname(node24), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  ...pathDirectories.map((directory) => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
].filter(Boolean).map((candidate) => resolve(candidate));
const npmCli = [...new Set(npmCandidates)].find(exists);
if (!npmCli) throw new Error('npm-cli.js was not found. Set AIMUSE_NPM_CLI to its absolute path.');

const args = process.argv.slice(2);
if (!args.length) args.push('--version');
const result = spawnSync(node24, [npmCli, ...args], {
  cwd: process.cwd(),
  env: { ...process.env, PATH: `${dirname(node24)}${delimiter}${process.env.PATH ?? ''}` },
  stdio: 'inherit',
  windowsHide: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

