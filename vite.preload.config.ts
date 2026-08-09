import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common') } },
  build: { sourcemap: true, rollupOptions: { external: ['electron'] } },
});
