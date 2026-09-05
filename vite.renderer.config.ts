import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  envDir: false,
  publicDir: false,
  cacheDir: resolve(process.env.XDG_CACHE_HOME || resolve(__dirname, 'node_modules', '.vite'), 'aimuse-renderer'),
  css: { postcss: {} },
  plugins: [react()],
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common'), '@renderer': resolve(__dirname, 'src/renderer') } },
  build: { sourcemap: true },
});
