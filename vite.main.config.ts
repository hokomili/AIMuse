import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@aimuse/core': resolve(__dirname, 'packages/core/src/index.ts'), '@common': resolve(__dirname, 'src/common'), '@main': resolve(__dirname, 'src/main') } },
  build: {
    sourcemap: true,
    lib: {
      entry: { main: resolve(__dirname, 'src/main/main.ts'), 'playback-render-worker': resolve(__dirname, 'src/main/playback-render-worker.ts') },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: { external: ['electron'] },
  },
});
