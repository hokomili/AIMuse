import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/renderer-browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: 'test-results/renderer-headless',
  reporter: [['list']],
  use: { channel: 'chrome', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
