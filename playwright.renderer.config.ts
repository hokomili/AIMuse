import { defineConfig } from '@playwright/test';
import { resolveRendererOutputSelection } from './scripts/playwright-output.mjs';

const rendererOutput = resolveRendererOutputSelection({ workspace: __dirname });
const rendererBrowserExecutable = process.env.AIMUSE_RENDERER_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: './tests/renderer-browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: rendererOutput.outputDir,
  reporter: [['list']],
  use: {
    ...(rendererBrowserExecutable ? { executablePath: rendererBrowserExecutable } : { channel: 'chrome' as const }),
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
