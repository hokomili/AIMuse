import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function packagePlatformDecision(platform) {
  if (platform === 'win32') return { allowed: true, platform, reason: 'The audited Windows package path remains enabled.' };
  if (platform === 'darwin') return {
    allowed: false,
    platform,
    reason: 'macOS packaging is blocked until CoreAudio runtime binaries, native bundle staging, hardened-runtime entitlements, signing, notarization and package verification are implemented and accepted on macOS.',
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
