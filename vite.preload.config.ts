import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  envDir: false,
  publicDir: false,
  cacheDir: resolve(process.env.XDG_CACHE_HOME || resolve(__dirname, 'node_modules', '.vite'), 'aimuse-preload'),
  css: { postcss: {} },
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common') } },
  build: { sourcemap: true, rollupOptions: { external: ['electron'] } },
});
