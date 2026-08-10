import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@common': resolve(__dirname, 'src/common'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/core/**/*.test.ts',
      'tests/main/**/*.test.ts',
      'tests/renderer/**/*.test.ts',
      'tests/native/audio-playback-mode-source.test.ts',
      'tests/scripts/portability.test.mjs',
      'tests/scripts/platform-test-routing.test.ts',
      'tests/scripts/macos-structure.test.mjs',
      'tests/scripts/macos-coreaudio-smoke.test.mjs',
    ],
  },
});
