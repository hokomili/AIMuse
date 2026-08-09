import { expect, test, type Page } from '@playwright/test';
import { createProject, type AsyncJob } from '@aimuse/core';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type { GenerationJobResult } from '../../src/common/generation';
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

function snapshot(empty = false): WorkspaceSnapshot {
  const project = createProject('song', 'Control Surface QA');
  const timestamp = new Date().toISOString();
  project.assets.asset_audition_ui = {
    id: 'asset_audition_ui', revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'agent-ui', updatedBy: 'agent-ui',
    kind: 'audition', name: 'Audition fixture.wav', mimeType: 'audio/wav', sha256: 'b'.repeat(64), byteLength: 384_044,
    storage: 'managed-cache', sampleRate: 48_000, channels: 2, durationSamples: 96_000, source: 'render',
  };
  const candidateJob: AsyncJob<GenerationJobResult> = {
    id: 'generation-job_ui', ownerActorId: 'human-local', projectId: project.id, kind: 'generation', status: 'completed', progress: 1,
    message: 'Candidate ready.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancellable: false,
    result: {
      request: { projectId: project.id, provider: 'elevenlabs', model: 'music_v1', kind: 'music', prompt: 'Fixture', instrumental: true, durationMs: 3_000, resultCount: 1, referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', providerOptions: {} },
      candidates: [{ id: 'candidate_ui', asset: { id: 'asset_ui', revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: 'human-local', updatedBy: 'human-local', kind: 'audio', name: 'Generated fixture.mp3', mimeType: 'audio/mpeg', sha256: 'a'.repeat(64), byteLength: 32, storage: 'managed-cache', source: 'generation' }, managedPath: 'fixture.mp3', providerMetadata: {} }],
      acceptedCandidateIds: [], rejectedCandidateIds: [],
    },
  };
  return {
    projects: empty ? [] : [{ id: project.id, name: project.name, kind: project.kind, dirty: true, revision: project.revision }],
    activeProjectId: empty ? undefined : project.id,
    activeProject: empty ? undefined : project,
    jobs: empty ? [] : [candidateJob], plugins: [], locks: [],
    mcp: { running: true, url: 'http://127.0.0.1:48000/mcp', port: 48_000, tokenHint: 'abcd', sessions: [] },
    transport: { status: 'stopped', tick: 0, sample: 0, loopEnabled: false, loopStartTick: 0, loopEndTick: 15_360, metronomeEnabled: true, cpuLoad: 0, xruns: 0, latencySamples: 256, graphRevision: 0 },
    selection: undefined, canUndo: true, canRedo: true,
  };
}

async function openEditor(page: Page, empty = false): Promise<void> {
  const initial = snapshot(empty);
  await page.addInitScript((seed) => {
    const state = structuredClone(seed);
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
      saveProject: async () => ({ saved: true, warnings: [] }), saveProjectAs: async () => ({ saved: true, warnings: [] }),
      closeProject: async (projectId: string) => { record('closeProject', projectId); return { closed: true }; },
      acquireHumanLock: async () => ({ acquired: true, lockId: 'lock_ui' }), refreshHumanLock: async () => ({ refreshed: true }), releaseHumanLock: async () => undefined,
      updateSelection: async (selection: unknown) => { record('updateSelection', selection); state.selection = structuredClone(selection) as never; },
      transport: async (action: string, options?: Record<string, unknown>) => { record('transport', action, options); if (action === 'loop') state.transport.loopEnabled = Boolean(options?.loopEnabled); if (action === 'seek') state.transport.tick = Number(options?.tick ?? 0); state.transport.status = action === 'play' ? 'playing' : action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : state.transport.status; eventListener?.({ type: 'transport', state: structuredClone(state.transport) }); return structuredClone(state.transport); },
      stopAgents: async () => 0,
      getEngineStatus: async () => ({ running: true, uiAttached: true, startsAtLogin: false, startAtLoginSupported: true, mode: 'interactive', audio: { mode: 'fallback', connected: false, driver: 'offline' } }),
      setEngineStartAtLogin: async () => ({}), getMcpCredentials: async () => ({ url: state.mcp.url, token: 'fixture-token' }),
      configureAgentClient: async (clientId: string) => { record('configureAgentClient', clientId); return { status: 'manual', clientId, clientName: 'Fixture client', message: 'Fixture connection instructions.', restartRequired: false, restartInstruction: 'Reconnect.', documentationUrl: 'https://example.test/mcp', setupSnippet: clientId === 'generic' ? '{ "transport": "streamable-http" }' : undefined }; },
      configureCodex: async () => ({ status: 'manual', clientId: 'codex', clientName: 'Codex', message: 'Fixture connection instructions.', restartRequired: false, restartInstruction: 'Reconnect.', documentationUrl: 'https://example.test/mcp' }),
      showApplicationMenu: async () => { record('showApplicationMenu'); },
      mediaUrl: (projectId: string, assetId: string) => `aimuse://media/project/${projectId}/${assetId}`,
      candidateMediaUrl: (jobId: string, candidateId: string) => `aimuse://media/candidate/${jobId}/${candidateId}`,
      resolveJob: async () => undefined, cancelJob: async () => undefined,
      importMedia: async () => ({ imported: 0, warnings: [] }), exportProject: async () => ({ exported: false, cancelled: true, warnings: [] }),
      createCheckpoint: async () => ({ checkpointId: 'checkpoint_ui' }), restoreCheckpoint: async () => ({ status: 'committed' }),
      scanPlugins: async () => ({ jobId: 'scan_ui' }), generationStart: async () => ({ jobId: 'generation_ui' }),
      generationAccept: async () => ({ status: 'committed' }), generationReject: async () => undefined,
      setProviderCredential: async () => ({ saved: true }),
      getProviderCapabilities: async () => [{ provider: 'elevenlabs', configured: true, experimental: false, models: [{ id: 'music_v1', label: 'Music v1', capabilities: ['text-to-music'], minDurationMs: 3_000, maxDurationMs: 600_000, formats: ['mp3'], costKnownBeforeRequest: false }] }],
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
  await expect(page.getByTitle('Recording input is not available in this alpha build')).toBeDisabled();

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

test('previews generation candidates and opens agent connection without a project', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Preview Audition fixture.wav' }).click();
  await expect.poll(() => callNames(page)).toContain('audio.play');
  await page.getByRole('button', { name: 'Generate' }).first().click();
  await page.getByRole('button', { name: 'Preview Generated fixture.mp3' }).click();
  await expect.poll(() => callNames(page)).toContain('audio.play');

  await page.reload();
  await openEditor(page, true);
  await page.getByRole('button', { name: /Connect an agent/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Connect an external agent' })).toBeVisible();
  const client = page.getByLabel('MCP client');
  await expect(client.locator('option')).toHaveText(['Codex', 'Claude Code', 'OpenCode', 'Antigravity', 'Other MCP client']);
  await client.selectOption('antigravity');
  await page.getByRole('button', { name: 'Configure Antigravity' }).click();
  await expect(page.getByText('Fixture connection instructions.')).toBeVisible();
  await expect.poll(() => callNames(page)).toContain('configureAgentClient');
  await page.getByRole('button', { name: 'Reveal token' }).click();
  await expect(page.getByText('fixture-token')).toBeVisible();
});
