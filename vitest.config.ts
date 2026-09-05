import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * These subjects intentionally use Win32 absolute-path fixtures, ACL/handle
 * semantics, or retained Windows coordinator state. They remain part of the
 * unchanged default suite on Windows, but are not executable product tests on
 * POSIX hosts.
 */
export const WINDOWS_SEALED_TESTS = [
  'tests/native/audio-teardown.checkpoint.test.ts',
  'tests/scripts/qa-evidence.test.mjs',
  'tests/scripts/qa-private-root-lease-contract.test.mjs',
  'tests/scripts/qa-private-root-node-api-execution-cwd.test.mjs',
  'tests/scripts/qa-private-root-node-api-provider.test.mjs',
  'tests/scripts/qa-private-root-node-api-rename-diagnostics.test.mjs',
  'tests/scripts/qa-private-root-node-api-replacement-identity-diagnostics.test.mjs',
  'tests/scripts/qa-session-faults.test.ts',
] as const;

export function platformTestExcludes(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [] : [...WINDOWS_SEALED_TESTS];
}

export default defineConfig({
  envDir: false,
  cacheDir: resolve(process.env.XDG_CACHE_HOME || resolve(__dirname, 'node_modules', '.vite'), 'aimuse-vitest'),
  resolve: {
    alias: {
      '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@common': resolve(__dirname, 'src/common'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    cache: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    exclude: platformTestExcludes(),
    coverage: { reporter: ['text', 'html'] },
  },
});
