import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('macOS silent headless main-process wiring', () => {
  it('installs background policy before readiness and admits windows only through the serialized presentation lifecycle', async () => {
    const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    const earlyBackground = source.indexOf('installEarlyBackgroundPresentation(shouldStartInBackground(startupRequest), app)');
    const singleInstanceLock = source.indexOf('app.requestSingleInstanceLock');
    const firstReady = source.indexOf('app.whenReady()');
    const createStart = source.indexOf('async function createWindow()');
    const serializedShow = source.indexOf('editorPresentation.show', createStart);
    const browserWindow = source.indexOf('new BrowserWindow', createStart);

    expect(earlyBackground).toBeGreaterThan(0);
    expect(earlyBackground).toBeLessThan(singleInstanceLock);
    expect(earlyBackground).toBeLessThan(firstReady);
    expect(serializedShow).toBeGreaterThan(createStart);
    expect(serializedShow).toBeLessThan(browserWindow);
    expect(source).toContain('void editorPresentation.detached()');
  });

  it('never treats ordinary macOS activation as permission to create an editor', async () => {
    const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    const activationStart = source.indexOf("app.on('activate'");
    const activationEnd = source.indexOf("app.on('window-all-closed'", activationStart);
    const activationRoute = source.slice(activationStart, activationEnd);

    expect(activationStart).toBeGreaterThan(0);
    expect(activationRoute).toContain('editorPresentation.activated()');
    expect(activationRoute).not.toContain('createWindow()');
  });

  it('packages as a UIElement so LaunchServices cannot infer a Dock role before editor admission', async () => {
    const source = await readFile(new URL('../../forge.config.ts', import.meta.url), 'utf8');
    const verifier = await readFile(new URL('../../scripts/verify-package.mjs', import.meta.url), 'utf8');

    expect(source).toContain('LSUIElement: true');
    expect(verifier).toContain("plistValue(infoPlist, 'LSUIElement')");
    expect(verifier).toContain("uiElement !== 'true'");
  });

  it('keeps exact show admission and awaited engine teardown on the only promotion and terminal-quit routes', async () => {
    const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    const showStart = source.indexOf('async function requestShow');
    const showEnd = source.indexOf('async function initialize', showStart);
    const showRoute = source.slice(showStart, showEnd);
    const quitStart = source.indexOf('async function requestQuit');
    const quitEnd = showStart;
    const quitRoute = source.slice(quitStart, quitEnd);
    const showAdmission = showRoute.indexOf('evaluateShowRequest');
    const showCreation = showRoute.indexOf('createWindow()');

    expect(showAdmission).toBeGreaterThan(0);
    expect(showCreation).toBeGreaterThan(showAdmission);
    expect(showRoute).toContain("completeShowAcknowledgement(decision.requestId, 'accepted')");
    expect(quitRoute.indexOf('await runtime?.stop()')).toBeLessThan(quitRoute.indexOf('app.quit()'));
    expect(source).toContain('requestQuit(false)');
  });
});
