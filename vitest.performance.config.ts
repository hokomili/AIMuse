import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  envDir: false,
  cacheDir: resolve(process.env.XDG_CACHE_HOME || resolve(__dirname, 'node_modules', '.vite'), 'aimuse-vitest-performance'),
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common'), '@main': resolve(__dirname, 'src/main') } },
  test: { cache: false, environment: 'node', include: ['tests/performance/**/*.perf.ts'], testTimeout: 180_000, hookTimeout: 30_000, sequence: { concurrent: false } },
});
