import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function packagePlatformDecision(platform) {
  if (platform === 'win32') return { allowed: true, platform, reason: 'The audited Windows package path remains enabled.' };
  if (platform === 'darwin') return {
    allowed: true,
    platform,
    mode: 'development',
    reason: 'The macOS development .app path is enabled; release still requires Developer ID signing, notarization, stapling and independent exact-build acceptance.',
  };
  return { allowed: false, platform, reason: `Packaging is not implemented for ${platform}.` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const decision = packagePlatformDecision(process.platform);
  if (decision.allowed) process.stdout.write(`${JSON.stringify(decision)}\n`);
  else {
    process.stderr.write(`AIMuse package preflight failed closed: ${decision.reason}\n`);
    process.exitCode = 1;
  }
}
