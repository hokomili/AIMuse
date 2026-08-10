import { defineConfig } from '@playwright/test';
import { resolvePackagedE2eOutputSelection } from './scripts/playwright-output.mjs';

const packagedE2eOutput = resolvePackagedE2eOutputSelection({ workspace: __dirname });

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: packagedE2eOutput.outputDir,
  reporter: [['list'], ['html', { open: 'never', outputFolder: packagedE2eOutput.htmlReportDir }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
