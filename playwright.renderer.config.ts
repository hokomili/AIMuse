import { defineConfig } from '@playwright/test';
import { resolveRendererOutputSelection } from './scripts/playwright-output.mjs';

const rendererOutput = resolveRendererOutputSelection({ workspace: __dirname });

export default defineConfig({
  testDir: './tests/renderer-browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: rendererOutput.outputDir,
  reporter: [['list']],
  use: { channel: 'chrome', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
