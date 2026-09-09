import { expect, test, type Page } from '@playwright/test';
import { createProject, type AsyncJob } from '@aimuse/core';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type { WorkspaceSnapshot } from '../../src/common/contracts';

let server: ViteDevServer;
let editorUrl: string;

test.beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.renderer.config.ts'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('The headless renderer test server did not bind a TCP port.');
  editorUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server.close(); });

function snapshot(empty = false, waitingApproval = false): WorkspaceSnapshot {
  const project = createProject('song', 'Control Surface QA');
  const timestamp = new Date().toISOString();
  project.assets.asset_audition_ui = {
    id: 'asset_audition_ui', revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'agent-ui', updatedBy: 'agent-ui',
    kind: 'audition', name: 'Audition fixture.wav', mimeType: 'audio/wav', sha256: 'b'.repeat(64), byteLength: 384_044,
    storage: 'managed-cache', sampleRate: 48_000, channels: 2, durationSamples: 96_000, source: 'render',
  };
  project.assets.asset_sf2_ui = { id: 'asset_sf2_ui', revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'human-local', updatedBy: 'human-local', kind: 'soundfont', name: 'Custom library.sf2', mimeType: 'audio/sf2', sha256: 'c'.repeat(64), byteLength: 1000, storage: 'managed-cache', soundfontPresets: [{ bank: 0, program: 5, name: 'Custom keys' }] };
  const approvalJob: AsyncJob = {
    id: 'approval-job_ui', ownerActorId: 'agent-ui', projectId: project.id, kind: 'render', status: 'waiting-for-user', progress: 0,
    message: 'Export requires approval.', createdAt: timestamp, updatedAt: timestamp, cancellable: true,
    approval: { kind: 'file-write', summary: 'Fixture agent requests a MIDI export.', request: { kind: 'midi' }, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  return {
    projects: empty ? [] : [{ id: project.id, name: project.name, kind: project.kind, dirty: true, revision: project.revision }],
    activeProjectId: empty ? undefined : project.id,
    activeProject: empty ? undefined : project,
    jobs: empty || !waitingApproval ? [] : [approvalJob], plugins: [], locks: [],
    mcp: { running: true, connectionMode: 'stdio-bridge', message: 'Ready for configured external agents.', sessions: [] },
    transport: { status: 'stopped', tick: 0, sample: 0, loopEnabled: false, loopStartTick: 0, loopEndTick: 15_360, metronomeEnabled: true, cpuLoad: 0, xruns: 0, latencySamples: 256, graphRevision: 0 },
    selection: undefined, canUndo: true, canRedo: true,
  };
}

async function openEditor(page: Page, empty = false, waitingApproval = false): Promise<void> {
  const initial = { state: snapshot(empty, waitingApproval) };
  await page.addInitScript((seed) => {
    const state = structuredClone(seed.state);
    let eventListener: ((event: unknown) => void) | undefined;
    const calls: Array<{ name: string; args: unknown[] }> = [];
    Object.defineProperty(window, '__aimuseCalls', { value: calls, configurable: true });
    const record = (name: string, ...args: unknown[]) => calls.push({ name, args: structuredClone(args) });
    const emit = () => eventListener?.({ type: 'workspace', snapshot: structuredClone(state) });
    const applyOperation = (operation: Record<string, unknown>) => {
      const project = state.activeProject as Record<string, any> | undefined; if (!project) return;
      if (operation.kind === 'project.settings.update') Object.assign(project.settings, operation.changes);
      if (operation.kind === 'track.update') { Object.assign(project.tracks[String(operation.trackId)], operation.changes); project.tracks[String(operation.trackId)].revision += 1; }
      if (operation.kind === 'track.add') { const track = structuredClone(operation.track) as Record<string, any>; project.tracks[track.id] = track; project.trackOrder.splice(Number(operation.index ?? project.trackOrder.length), 0, track.id); }
      if (operation.kind === 'clip.add') { const clip = structuredClone(operation.clip) as Record<string, any>; project.clips[clip.id] = clip; project.tracks[clip.trackId].clipIds.push(clip.id); }
      if (operation.kind === 'clip.move') { const clip = project.clips[String(operation.clipId)]; clip.startTick = Number(operation.startTick); clip.revision += 1; }
      if (operation.kind === 'clip.trim') { const clip = project.clips[String(operation.clipId)]; clip.startTick = Number(operation.startTick); clip.durationTicks = Number(operation.durationTicks); clip.revision += 1; }
      if (operation.kind === 'clip.split') { const clip = project.clips[String(operation.clipId)]; const right = structuredClone(operation.rightClip) as Record<string, any>; const leftDuration = Number(operation.tick) - clip.startTick; right.startTick = Number(operation.tick); right.durationTicks = clip.durationTicks - leftDuration; clip.durationTicks = leftDuration; clip.revision += 1; project.clips[right.id] = right; project.tracks[clip.trackId].clipIds.push(right.id); }
      if (operation.kind === 'marker.add') { const marker = structuredClone(operation.marker) as Record<string, any>; project.markers[marker.id] = marker; project.markerOrder.push(marker.id); }
      if (operation.kind === 'marker.update') { Object.assign(project.markers[String(operation.markerId)], operation.changes); project.markers[String(operation.markerId)].revision += 1; }
      if (operation.kind === 'marker.delete') { delete project.markers[String(operation.markerId)]; project.markerOrder = project.markerOrder.filter((id: string) => id !== operation.markerId); }
      if (operation.kind === 'section.add') { const section = structuredClone(operation.section) as Record<string, any>; project.sections[section.id] = section; project.sectionOrder.push(section.id); }
      if (operation.kind === 'section.update') { Object.assign(project.sections[String(operation.sectionId)], operation.changes); project.sections[String(operation.sectionId)].revision += 1; }
      if (operation.kind === 'section.delete') { delete project.sections[String(operation.sectionId)]; project.sectionOrder = project.sectionOrder.filter((id: string) => id !== operation.sectionId); }
      if (operation.kind === 'lyrics.set') project.lyrics = String(operation.lyrics);
      if (operation.kind === 'device.update') { Object.assign(project.devices[String(operation.deviceId)], operation.changes); project.devices[String(operation.deviceId)].revision += 1; }
      if (operation.kind === 'device.add') { const device = structuredClone(operation.device) as Record<string, any>; project.devices[device.id] = device; project.tracks[device.trackId].deviceIds.push(device.id); }
      if (operation.kind === 'automation.lane.add') { const lane = structuredClone(operation.lane) as Record<string, any>; project.automationLanes[lane.id] = lane; project.tracks[lane.trackId].automationLaneIds.push(lane.id); }
      project.revision += 1; state.projects[0].revision = project.revision;
    };
    const api = {
      bootstrap: async () => structuredClone(state),
      newProject: async () => structuredClone(state),
      activateProject: async (projectId: string) => { record('activateProject', projectId); return structuredClone(state); },
      applyTransaction: async (edit: Record<string, any>) => { record('applyTransaction', edit); edit.operations.forEach(applyOperation); emit(); return { status: 'committed', revision: state.activeProject?.revision }; },
      undo: async (projectId?: string) => { record('undo', projectId); return { status: 'committed' }; },
      redo: async (projectId?: string) => { record('redo', projectId); return { status: 'committed' }; },
      openProjects: async () => { record('openProjects'); return { opened: [], warnings: [] }; },
      saveProject: async (projectId?: string) => { record('saveProject', projectId); return { saved: true, warnings: [] }; }, saveProjectAs: async (projectId?: string) => { record('saveProjectAs', projectId); return { saved: true, projectPath: '/fixture/Control Surface QA copy.aimuse', warnings: [] }; },
      closeProject: async (projectId: string) => { record('closeProject', projectId); return { closed: true }; },
      acquireHumanLock: async (request: unknown) => { record('acquireHumanLock', request); return { acquired: true, lockId: 'lock_ui' }; },
      refreshHumanLock: async (lockId: string) => { record('refreshHumanLock', lockId); return { refreshed: true, expiresAt: new Date(Date.now() + 10_000).toISOString() }; },
      holdHumanLock: async (lockId: string) => { record('holdHumanLock', lockId); return { held: true, expiresAt: new Date(Date.now() + 15_000).toISOString() }; },
      releaseHumanLock: async (lockId: string) => { record('releaseHumanLock', lockId); },
      updateSelection: async (selection: unknown) => { record('updateSelection', selection); state.selection = structuredClone(selection) as never; },
      transport: async (action: string, options?: Record<string, unknown>) => { record('transport', action, options); if (action === 'loop') state.transport.loopEnabled = Boolean(options?.loopEnabled); if (action === 'seek') state.transport.tick = Number(options?.tick ?? 0); state.transport.status = action === 'play' ? 'playing' : action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : state.transport.status; eventListener?.({ type: 'transport', state: structuredClone(state.transport) }); return structuredClone(state.transport); },
      stopAgents: async () => 0,
      getEngineStatus: async () => ({ running: true, uiAttached: true, startsAtLogin: false, startAtLoginSupported: true, mode: 'interactive', audio: { mode: 'fallback', connected: false, driver: 'offline' } }),
      setEngineStartAtLogin: async () => ({}),
      getAgentClientSettings: async (clientId: string) => { record('getAgentClientSettings', clientId); return { status: 'one-time', clientId, clientName: 'Fixture client', message: 'Fixture one-time connection instructions.', restartRequired: true, restartInstruction: 'Restart once.', documentationUrl: 'https://example.test/mcp', setupSnippet: '{ "transport": "stdio", "command": "/Applications/AIMuse" }' }; },
      showApplicationMenu: async () => { record('showApplicationMenu'); },
      mediaUrl: (projectId: string, assetId: string) => `aimuse://media/project/${projectId}/${assetId}`,
      resolveJob: async () => undefined, cancelJob: async () => undefined,
      importMedia: async () => ({ imported: 0, warnings: [] }), exportProject: async () => ({ exported: false, cancelled: true, warnings: [] }),
      createCheckpoint: async () => ({ checkpointId: 'checkpoint_ui' }), restoreCheckpoint: async () => ({ status: 'committed' }),
      scanPlugins: async () => ({ jobId: 'scan_ui' }),
      installAuthorityPolicy: async () => ({ installed: true }), replayTrace: async () => ({ replaying: true }),
      onEvent: (callback: (event: unknown) => void) => { eventListener = callback; return () => { eventListener = undefined; }; },
      onNewProjectRequested: () => () => undefined,
    };
    class MockAudio {
      paused = true; onended?: () => void; onerror?: () => void;
      constructor(readonly src: string) { record('audio.create', src); }
      play() { this.paused = false; record('audio.play', this.src); return Promise.resolve(); }
      pause() { if (!this.paused) record('audio.pause', this.src); this.paused = true; }
    }
    Object.defineProperty(window, 'Audio', { value: MockAudio, configurable: true });
    Object.defineProperty(window, 'aimuse', { value: api, configurable: true });
  }, initial);
  await page.goto(editorUrl);
  await expect(page.locator('.app-brand')).toContainText('AIMuse');
}

async function callNames(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __aimuseCalls: Array<{ name: string }> }).__aimuseCalls.map((entry) => entry.name));
}

async function transactionLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __aimuseCalls: Array<{ name: string; args: Array<{ label?: string }> }> }).__aimuseCalls.filter((entry) => entry.name === 'applyTransaction').map((entry) => entry.args[0]?.label ?? ''));
}

test('wires the main studio controls to durable UI actions', async ({ page }) => {
  await openEditor(page);

  await page.getByTitle('New project').click();
  await expect(page.getByRole('heading', { name: 'New Song' })).toBeVisible();
  await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: '', bubbles: true })));
  await expect(page.getByRole('heading', { name: 'New Song' })).toBeHidden();

  await page.getByTitle('Application menu').click();
  await page.getByTitle('Metronome').click();
  await page.getByTitle('Cycle count-in').click();
  await page.getByRole('button', { name: 'Collapse Ideas' }).click();
  await expect.poll(() => callNames(page)).toContain('showApplicationMenu');
  await expect.poll(() => transactionLabels(page)).toEqual(expect.arrayContaining(['Toggle metronome', 'Change count-in', 'Collapse Ideas']));

  await page.getByRole('button', { name: 'Expand Ideas' }).click();
  await page.getByRole('button', { name: 'Draw MIDI clip tool' }).click();
  await expect(page.getByRole('button', { name: 'Draw MIDI clip tool' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.track-lane').first().click({ position: { x: 40, y: 30 } });
  await expect.poll(() => transactionLabels(page)).toContain('Create MIDI clip');
  await expect(page.getByRole('combobox', { name: 'SoundFont preset' })).toHaveValue('0:0');
  await page.getByRole('button', { name: 'Split tool' }).click();
  await page.locator('.arrangement-clip').first().click({ position: { x: 30, y: 20 } });
  await expect.poll(() => transactionLabels(page)).toContain('Split “New idea”');

  await page.locator('.track-header').first().click();
  await page.getByRole('button', { name: 'Add device to Ideas' }).click();
  await expect(page.getByPlaceholder('Search instruments')).toBeVisible();
  await page.getByPlaceholder('Search instruments').fill('sampler');
  await page.getByRole('button', { name: /Sampler/ }).click();
  await expect.poll(() => transactionLabels(page)).toContain('Add Sampler');

  await page.getByRole('button', { name: 'Mixer' }).click();
  await page.getByRole('button', { name: '＋ Insert' }).last().click();
  await expect(page.getByPlaceholder('Search effects')).toBeVisible();
  await expect(page.getByPlaceholder('Search effects')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Parametric EQ/ })).toBeVisible();
  await page.locator('.track-header').first().click();
  await page.getByRole('button', { name: /Automation/ }).click();
  await page.getByRole('button', { name: 'Add track volume automation' }).click();
  await expect.poll(() => transactionLabels(page)).toContain('Add track volume automation');

  await page.getByRole('button', { name: 'Collapse editor' }).click();
  await expect(page.getByRole('button', { name: 'Expand editor' })).toBeVisible();
  await expect(page.getByTitle('Recording is planned for a later release')).toBeDisabled();

  await page.locator('.track-header').first().click();
  const name = page.locator('.inspector .property-group input').first();
  await name.fill('Keyboard history QA');
  await name.press('Tab');
  await expect.poll(() => transactionLabels(page)).toContain('Edit Ideas');
  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Y');
  await expect.poll(() => callNames(page)).toEqual(expect.arrayContaining(['undo', 'redo']));

  await page.getByRole('button', { name: 'Close Control Surface QA', exact: true }).click();
  await expect.poll(() => callNames(page)).toContain('closeProject');
});

test('previews project media and opens agent connection without a project', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Preview Audition fixture.wav' }).click();
  await expect.poll(() => callNames(page)).toContain('audio.play');

  await page.reload();
  await openEditor(page, true);
  await page.getByRole('button', { name: /Connect an agent/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Connect an external agent' })).toBeVisible();
  const client = page.getByLabel('MCP client');
  await expect(client.locator('option')).toHaveText(['Codex', 'Claude Code', 'OpenCode', 'Antigravity', 'Other MCP client']);
  await client.selectOption('antigravity');
  await page.getByRole('button', { name: 'Show Antigravity one-time setup' }).click();
  await expect(page.getByText('Fixture one-time connection instructions.')).toBeVisible();
  await expect.poll(() => callNames(page)).toContain('getAgentClientSettings');
  await expect(page.getByRole('button', { name: 'Copy one-time setup' })).toBeVisible();
  await expect(page.getByText('Automatic after AIMuse launches')).toBeVisible();
  await expect(page.getByText(/bearer token/i)).toHaveCount(0);
});

test('exposes distinct Save As, clip move/trim/split, and song-structure workflows', async ({ page }) => {
  await openEditor(page);

  await page.getByTitle('Save As').click();
  await expect.poll(() => callNames(page)).toContain('saveProjectAs');
  await expect(page.getByText(/Project saved as .*Control Surface QA copy\.aimuse/)).toBeVisible();

  await page.getByRole('button', { name: 'MIDI clip', exact: true }).click();
  await expect.poll(() => transactionLabels(page)).toContain('Create MIDI clip');
  await expect(page.locator('.arrangement-clip').first()).toBeVisible();
  await page.locator('.arrangement-clip').first().click();
  const start = page.getByLabel('Clip start tick');
  await start.fill('240');
  await start.press('Enter');
  const length = page.getByLabel('Clip length ticks');
  await length.fill('7680');
  await length.press('Enter');
  await page.getByRole('button', { name: /Split New idea at midpoint/ }).click();
  await expect.poll(() => transactionLabels(page)).toEqual(expect.arrayContaining(['Move “New idea”', 'Trim “New idea”', 'Split “New idea” at midpoint']));

  await page.locator('.right-tabs').getByRole('button', { name: 'Song', exact: true }).click();
  await page.getByRole('button', { name: '＋ At selection' }).click();
  await page.getByRole('button', { name: '＋ From selection' }).click();
  await expect(page.getByLabel(/Marker name Marker 1/)).toBeVisible();
  await expect(page.getByLabel(/Section name Section 1/)).toBeVisible();
  await page.getByLabel('Lyrics').fill('Certifiable native lyrics checkpoint');
  await page.getByRole('button', { name: 'Save lyrics' }).click();
  await expect.poll(() => transactionLabels(page)).toEqual(expect.arrayContaining(['Add Marker 1', 'Add Section 1', 'Set song lyrics']));
});

test('holds a completed clip gesture for a visible bounded agent-conflict window', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'MIDI clip', exact: true }).click();
  const clip = page.locator('.arrangement-clip').first();
  await expect(clip).toBeVisible();
  const box = await clip.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  const lockStatus = page.locator('.human-lock-status');
  await expect(lockStatus).toContainText('Human edit lock active');
  await page.mouse.move(box!.x + 45, box!.y + 20, { steps: 3 });
  await page.mouse.up();

  await expect(lockStatus).toContainText(/Human edit protected · \d+s/);
  await expect.poll(() => callNames(page)).toEqual(expect.arrayContaining(['acquireHumanLock', 'holdHumanLock']));
  await expect(clip).toHaveClass(/human-protected/);
  await page.getByRole('button', { name: 'Release human edit lock now' }).click();
  await expect.poll(() => callNames(page)).toContain('releaseHumanLock');
  await expect(lockStatus).toHaveCount(0);
});

test('renders one admitted human approval request with one decision surface', async ({ page }) => {
  await openEditor(page, false, true);
  await expect(page.locator('.right-toggle em')).toHaveText('1');
  await page.locator('.right-tabs').getByRole('button', { name: /^Jobs/ }).click();
  await expect(page.locator('.job-card.waiting-for-user')).toHaveCount(1);
  await expect(page.locator('.approval-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Allow for session' })).toHaveCount(1);
});

test('does not expose built-in generation or provider credential controls', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toHaveCount(0);
  await expect(page.getByText(/provider credential/i)).toHaveCount(0);
  await expect(page.getByText(/API key/i)).toHaveCount(0);
});


test('selects and searches SoundFont instruments through attributed preset edits', async ({ page }) => {
  await openEditor(page);
  await page.locator('.track-header').first().click();
  await page.getByRole('button', { name: 'Add device to Ideas' }).click();
  await page.getByRole('button', { name: /SoundFont.*287 presets/ }).click();
  const preset = page.getByRole('combobox', { name: 'SoundFont preset' });
  await expect(preset).toHaveValue('0:0');
  await preset.selectOption('0:48');
  await expect(preset).toHaveValue('0:48');
  await page.getByRole('textbox', { name: 'Find SoundFont preset' }).fill('drums');
  await preset.selectOption('128:0');
  await expect(preset).toHaveValue('128:0');
  await expect(page.getByText('Drum notes use General MIDI key mapping.', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'SoundFont library' }).selectOption('asset_sf2_ui');
  await expect(preset).toHaveValue('0:5');
  await expect(preset).toContainText('Custom keys');
  const edits = await page.evaluate(() => (window as unknown as { __aimuseCalls: Array<{ name: string; args: Array<{ operations?: Array<Record<string, unknown>> }> }> }).__aimuseCalls.flatMap((call) => call.args[0]?.operations ?? []).filter((operation) => operation.kind === 'device.update'));
  expect(edits).toEqual(expect.arrayContaining([expect.objectContaining({ changes: { soundfont: { source: 'generaluser-gs-2.0.3', bank: 128, program: 0 }, presetName: 'Standard 1' }, expectedRevision: 1 })]));
});
