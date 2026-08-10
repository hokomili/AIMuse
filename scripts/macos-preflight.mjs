import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function macosHostFailures({ platform, architecture, nodeVersion }) {
  const failures = [];
  if (platform !== 'darwin') failures.push(`macOS verification requires darwin, received ${platform}.`);
  if (!['arm64', 'x64'].includes(architecture)) failures.push(`macOS verification supports arm64 or x64, received ${architecture}.`);
  if (Number.parseInt(nodeVersion.replace(/^v/u, '').split('.')[0] ?? '', 10) !== 24) failures.push(`Node 24 is required, received ${nodeVersion}.`);
  return failures;
}

function inspectTool(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function macosVerificationContract() {
  return {
    runtimeBinariesBuilt: true,
    coreAudioSharedRuntimeBuilt: true,
    coreAudioDeviceSmokeRequired: true,
    coreAudioExclusiveClaimed: false,
    developmentPackageAvailable: true,
    developerIdSigningClaimed: false,
    notarizationClaimed: false,
    requiredTools: ['xcode-select', 'cmake', 'git'],
  };
}

async function main() {
  const failures = macosHostFailures({ platform: process.platform, architecture: process.arch, nodeVersion: process.version });
  if (failures.length) throw new Error(failures.join(' '));
  const result = {
    status: 'PASS',
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    xcodeDeveloperDirectory: inspectTool('xcode-select', ['-p']),
    cmake: inspectTool('cmake', ['--version']).split(/\r?\n/u)[0],
    git: inspectTool('git', ['--version']),
    contract: macosVerificationContract(),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`AIMuse macOS preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
