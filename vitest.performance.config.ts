import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common'), '@main': resolve(__dirname, 'src/main') } },
  test: { environment: 'node', include: ['tests/performance/**/*.perf.ts'], testTimeout: 180_000, hookTimeout: 30_000, sequence: { concurrent: false } },
});

