import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HUMAN_ACTOR, type AuthorityPolicy, type ProjectTransaction } from '@aimuse/core';
import { IPC, type ExportRequest, type HumanLockRequest, type NewProjectOptions, type TimelineSelection } from '../common/contracts';
import { buildAgentClientSetup, isAgentClientId, type AgentClientSetupResult } from '../common/agent-clients';
import { EngineRuntime } from './engine-runtime';
import { bootstrapMcpBridgeEntry, buildMcpBridgeLaunch } from './mcp-bridge-entry';
import { runMcpStdioBridge } from './mcp-stdio-bridge';
import { atomicWriteFile, unpackProjectPack } from './persistence';
import { profileIdForPath } from './profile-identity';
import { nativeExecutableName } from './platform';
import { AIMUSE_PROTOCOL_SCHEME } from './protocol-config';
import { assertTrustedRenderer, denyPermissionCheck, denyPermissionRequest, denyWindowOpen, guardRendererNavigation, preventWebviewAttachment } from './renderer-security';
import { evaluateShowRequest, parseSecondInstanceRequest, parseStartupRequest, shouldAcceptQuit, shouldInitializePrimary, type SingleInstanceRequest } from './single-instance';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined; let runtime: EngineRuntime; let shutdownComplete = false; let shutdownPending = false; let ready: Promise<void> | undefined; let rendererSurfaceReady: Promise<void> | undefined;
const applicationArguments = process.argv.slice(app.isPackaged ? 1 : 2); const valueFlag = (name: string): string | undefined => applicationArguments.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1); const bridgeBootstrap = bootstrapMcpBridgeEntry(applicationArguments, app); const bridgeEntry = bridgeBootstrap.entry; const bridgeMode = bridgeBootstrap.requested; const startupRequest = parseStartupRequest(applicationArguments); const headless = startupRequest.command === 'headless'; const connectionFile = valueFlag('--write-mcp-connection'); const authorityPolicyPath = valueFlag('--authority-policy'); const trustedFolders = applicationArguments.filter((argument) => argument.startsWith('--trust-folder=')).map((argument) => argument.slice('--trust-folder='.length)); const explicitUserData = valueFlag('--user-data-dir');
if (!bridgeMode) {
  if (headless) app.disableHardwareAcceleration();
  if (explicitUserData) { const path = resolve(explicitUserData); app.setPath('userData', path); app.setName(`AIMuse-${profileIdForPath(path).slice(0, 12).toLowerCase()}`); }
}
const hasLock = bridgeMode || app.requestSingleInstanceLock({ command: startupRequest.command, ...(startupRequest.instanceId ? { instanceId: startupRequest.instanceId } : {}), ...(startupRequest.profileId ? { profileId: startupRequest.profileId } : {}), ...(startupRequest.showRequestId ? { showRequestId: startupRequest.showRequestId } : {}) });
if (!bridgeMode) protocol.registerSchemesAsPrivileged([AIMUSE_PROTOCOL_SCHEME]);

function assertTrusted(event: IpcMainInvokeEvent): void { const frame = event.senderFrame; assertTrustedRenderer({ windowPresent: Boolean(mainWindow), senderMatchesWindow: Boolean(mainWindow && event.sender === mainWindow.webContents), frameMatchesMainFrame: Boolean(mainWindow && frame === mainWindow.webContents.mainFrame), frameUrl: frame?.url ?? '' }, MAIN_WINDOW_VITE_DEV_SERVER_URL); }
function handle<T extends unknown[], R>(channel: string, callback: (...args: T) => R | Promise<R>): void { ipcMain.handle(channel, (event, ...args: T) => { assertTrusted(event); return callback(...args); }); }

async function registerRendererProtocol(): Promise<void> {
  const root = resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  await protocol.handle('aimuse', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'app') {
        const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const path = resolve(root, `.${pathname}`); const local = relative(root, path);
        if (local.startsWith('..') || isAbsolute(local)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path).toString());
      }
      if (url.hostname !== 'media' || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      const [kind, firstId, secondId, ...extra] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (!kind || !firstId || !secondId || extra.length) return new Response('Not found', { status: 404 });
      let media: { path: string; mimeType: string } | undefined;
      if (kind !== 'project') return new Response('Not found', { status: 404 });
      const project = runtime.projects.getProject(firstId); const asset = project?.assets[secondId]; const path = asset && runtime.projects.getAssetSource(firstId, secondId);
      if (asset && path && ['audio', 'audition'].includes(asset.kind)) media = { path, mimeType: asset.mimeType };
      if (!media) return new Response('Media not found', { status: 404 });
      const range = request.headers.get('range');
      const response = await net.fetch(pathToFileURL(media.path).toString(), range ? { headers: { range } } : undefined);
      const headers = new Headers(response.headers); headers.set('content-type', media.mimeType); headers.set('cache-control', 'no-store');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
    } catch { return new Response('Bad request', { status: 400 }); }
  });
}

async function ensureRendererSurface(): Promise<void> {
  rendererSurfaceReady ??= (async () => {
    session.defaultSession.setPermissionCheckHandler(denyPermissionCheck);
    session.defaultSession.setPermissionRequestHandler(denyPermissionRequest);
    await registerRendererProtocol();
  })();
  await rendererSurfaceReady;
}

async function createWindow(): Promise<void> { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); return; } await ensureRendererSurface(); if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); return; } const window = new BrowserWindow({ width: 1580, height: 980, minWidth: 1080, minHeight: 680, backgroundColor: '#090a0f', title: 'AIMuse', show: false, webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } }); mainWindow = window; runtime.setUiAttached(true); window.webContents.setWindowOpenHandler(denyWindowOpen); window.webContents.on('will-navigate', (event, url) => guardRendererNavigation(event, url, MAIN_WINDOW_VITE_DEV_SERVER_URL)); window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; runtime.setUiAttached(false); }); window.once('ready-to-show', () => { window.show(); window.focus(); }); if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL); else await window.loadURL('aimuse://app/index.html'); }

async function saveProject(projectId?: string, saveAs = false) { const id = projectId ?? runtime.projects.getActiveProjectId(); const project = id ? runtime.projects.getProject(id) : undefined; if (!id || !project) return { saved: false, cancelled: true, warnings: [] }; let path = saveAs ? undefined : project.projectPath; if (!path) { const choice = await dialog.showSaveDialog(mainWindow!, { title: 'Save AIMuse project folder', defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '-')}.aimuse`, filters: [{ name: 'AIMuse working project', extensions: ['aimuse'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] }); if (choice.canceled || !choice.filePath) return { saved: false, cancelled: true, warnings: [] }; path = choice.filePath; } const result = await runtime.projects.save(id, path, HUMAN_ACTOR); return { saved: true, projectPath: result.projectPath, warnings: result.warnings }; }

async function openProjects() { const mode = await dialog.showMessageBox(mainWindow!, { type: 'question', title: 'Open AIMuse', message: 'Open a daily working folder or unpack a portable archive?', buttons: ['Working folder', 'Portable .aimusepack', 'Cancel'], defaultId: 0, cancelId: 2 }); if (mode.response === 2) return { opened: [], warnings: [] }; if (mode.response === 0) { const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Open AIMuse working folder', properties: ['openDirectory', 'multiSelections'] }); return choice.canceled ? { opened: [], warnings: [] } : runtime.projects.open(choice.filePaths); } const pack = await dialog.showOpenDialog(mainWindow!, { title: 'Open AIMuse portable pack', properties: ['openFile'], filters: [{ name: 'AIMuse portable pack', extensions: ['aimusepack'] }] }); if (pack.canceled || !pack.filePaths[0]) return { opened: [], warnings: [] }; const destination = await dialog.showSaveDialog(mainWindow!, { title: 'Create unpacked project folder', defaultPath: basename(pack.filePaths[0], '.aimusepack') + '.aimuse', properties: ['createDirectory'] }); if (destination.canceled || !destination.filePath) return { opened: [], warnings: [] }; try { return runtime.projects.open([await unpackProjectPack(pack.filePaths[0], destination.filePath)]); } catch (error) { return { opened: [], warnings: [error instanceof Error ? error.message : String(error)] }; } }

async function importMedia(projectId?: string) { const id = projectId ?? runtime.projects.getActiveProjectId(); if (!id) return { imported: 0, warnings: ['No project is open.'] }; const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Supported media', extensions: ['wav', 'flac', 'mp3', 'aac', 'm4a', 'ogg', 'mid', 'midi'] }, { name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'aac', 'm4a', 'ogg'] }, { name: 'MIDI', extensions: ['mid', 'midi'] }] }); if (choice.canceled) return { imported: 0, warnings: [] }; const result = await runtime.media.importPaths(id, choice.filePaths, HUMAN_ACTOR); return { imported: result.imported.length, warnings: result.warnings }; }

async function exportProject(request: Omit<ExportRequest, 'destination'>) { const project = runtime.projects.getProject(request.projectId); if (!project) return { exported: false, warnings: ['Project is not open.'] }; const folderLike = request.kind === 'stems' || request.kind === 'sfx-batch'; const extension = request.kind === 'midi' ? 'mid' : request.kind === 'dawproject' ? 'dawproject' : request.kind === 'pack' ? 'aimusepack' : request.format ?? 'wav'; const choice = await dialog.showSaveDialog(mainWindow!, { title: `Export ${request.kind}`, defaultPath: folderLike ? `${project.name} ${request.kind}` : `${project.name}.${extension}`, filters: folderLike ? undefined : [{ name: `${extension.toUpperCase()} export`, extensions: [extension] }], properties: ['showOverwriteConfirmation', 'createDirectory'] }); if (choice.canceled || !choice.filePath) return { exported: false, cancelled: true, warnings: [] }; const started = runtime.exports.start({ ...request, destination: choice.filePath, overwrite: true }, HUMAN_ACTOR); return { exported: true, jobId: started.jobId, destination: choice.filePath, warnings: [] }; }

async function closeProject(projectId: string, force = false): Promise<{ closed: boolean; reason?: string }> {
  if (force) return runtime.projects.close(projectId, true);
  const initial = await runtime.projects.close(projectId);
  if (initial.closed || initial.reason !== 'Project has unsaved changes.') return initial;
  const choice = await dialog.showMessageBox(mainWindow!, {
    type: 'warning', title: 'Unsaved AIMuse project', message: 'Save changes before closing?',
    detail: runtime.projects.getProject(projectId)?.name,
    buttons: ['Save', 'Discard changes', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
  });
  if (choice.response === 2) return { closed: false, reason: 'Close cancelled.' };
  if (choice.response === 0) {
    const saved = await saveProject(projectId);
    if (!saved.saved) return { closed: false, reason: saved.cancelled ? 'Save cancelled.' : saved.warnings[0] ?? 'Project was not saved.' };
  }
  return runtime.projects.close(projectId, true);
}

async function getAgentClientSettings(value: unknown): Promise<AgentClientSetupResult> {
  if (!isAgentClientId(value)) throw new Error('Unsupported MCP client.');
  return buildAgentClientSetup(value, buildMcpBridgeLaunch({ executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, targetProfilePath: app.getPath('userData') }));
}

function registerIpc(): void {
  handle(IPC.bootstrap, () => runtime.projects.snapshot()); handle(IPC.newProject, (options: NewProjectOptions) => runtime.projects.create(options, HUMAN_ACTOR)); handle(IPC.activateProject, (projectId: string) => runtime.projects.activate(projectId)); handle(IPC.applyTransaction, (transaction: ProjectTransaction) => runtime.projects.apply(transaction, HUMAN_ACTOR)); handle(IPC.undo, (projectId?: string) => runtime.projects.undo(projectId, HUMAN_ACTOR)); handle(IPC.redo, (projectId?: string) => runtime.projects.redo(projectId, HUMAN_ACTOR)); handle(IPC.openProjects, openProjects); handle(IPC.saveProject, (projectId?: string) => saveProject(projectId)); handle(IPC.saveProjectAs, (projectId?: string) => saveProject(projectId, true)); handle(IPC.closeProject, closeProject); handle(IPC.acquireHumanLock, (request: HumanLockRequest) => runtime.projects.acquireLock(request)); handle(IPC.refreshHumanLock, (lockId: string) => runtime.projects.refreshLock(lockId)); handle(IPC.holdHumanLock, (lockId: string) => runtime.projects.holdLock(lockId)); handle(IPC.releaseHumanLock, (lockId: string) => runtime.projects.releaseLock(lockId)); handle(IPC.updateSelection, (selection?: TimelineSelection) => runtime.projects.setSelection(selection)); handle(IPC.transport, (action: 'play' | 'record' | 'pause' | 'stop' | 'seek' | 'loop', options?: Parameters<AudioEngineTransport>[1]) => runtime.audio.transport(action, options)); handle(IPC.stopAgents, (projectId?: string) => { runtime.mcp.cancelQueuedMutations(projectId); return runtime.projects.stopAgents(projectId); });
  handle(IPC.engineStatus, () => ({ ...runtime.status(), startsAtLogin: app.getLoginItemSettings().openAtLogin })); handle(IPC.engineStartAtLogin, (enabled: boolean) => { app.setLoginItemSettings({ openAtLogin: enabled, args: ['--headless'] }); return { ...runtime.status(), startsAtLogin: app.getLoginItemSettings().openAtLogin }; }); handle(IPC.agentClientSettings, getAgentClientSettings); handle(IPC.showApplicationMenu, () => { if (mainWindow && !mainWindow.isDestroyed()) Menu.getApplicationMenu()?.popup({ window: mainWindow }); }); handle(IPC.resolveJob, (jobId: string, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny') => runtime.projects.resolveJob(jobId, decision)); handle(IPC.cancelJob, (jobId: string) => runtime.projects.cancelJob(jobId)); handle(IPC.importMedia, importMedia); handle(IPC.exportProject, exportProject); handle(IPC.checkpointCreate, (projectId: string, name: string) => runtime.projects.createCheckpoint(projectId, name, HUMAN_ACTOR)); handle(IPC.checkpointRestore, (projectId: string, checkpointId: string) => runtime.projects.restoreCheckpoint(projectId, checkpointId, HUMAN_ACTOR)); handle(IPC.scanPlugins, () => runtime.plugins.scan(undefined, HUMAN_ACTOR)); handle(IPC.installAuthorityPolicy, (policy: AuthorityPolicy) => runtime.authority.install(policy)); handle(IPC.replayTrace, (projectId: string, transactionId: string) => runtime.projects.replayTrace(projectId, transactionId));
}
type AudioEngineTransport = EngineRuntime['audio']['transport'];

function createMenu(): void { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'New Song', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send(IPC.newProjectRequested, 'song') }, { label: 'New SFX Project', accelerator: 'CmdOrCtrl+Shift+N', click: () => mainWindow?.webContents.send(IPC.newProjectRequested, 'sfx') }, { type: 'separator' }, { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openProjects() }, { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => void saveProject() }, { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => void saveProject(undefined, true) }, { type: 'separator' }, { label: 'Close Editor', role: 'close' }, { label: 'Quit AIMuse Engine…', click: () => void requestQuit() }] }, { label: 'Edit', submenu: [{ label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => void runtime.projects.undo(undefined, HUMAN_ACTOR) }, { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => void runtime.projects.redo(undefined, HUMAN_ACTOR) }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }])); }

async function requestQuit(confirmInEditor = true): Promise<void> {
  if (shutdownPending || shutdownComplete) return;
  shutdownPending = true;
  try {
    if (confirmInEditor && process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
      const dirty = runtime.projects.getProjects().filter((project) => project.dirty);
      const decision = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Quit AIMuse Engine',
        message: 'Quit the background engine and disconnect every agent?',
        detail: dirty.length
          ? `${dirty.length} unsaved project${dirty.length === 1 ? ' is' : 's are'} protected by crash recovery and will reopen next time.`
          : 'Closing the editor window alone keeps the headless engine available.',
        buttons: ['Quit Engine', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (decision.response !== 0) return;
    }
    await runtime?.stop();
    shutdownComplete = true;
    app.quit();
  } finally { shutdownPending = false; }
}
async function requestShow(request: SingleInstanceRequest): Promise<void> {
  const connection = runtime.mcp.connection();
  const decision = evaluateShowRequest(request, connection.instanceId, connection.profileId);
  if (decision.legacy) { await createWindow(); return; }
  if (!decision.requestId) return;
  if (!runtime.mcp.beginShowAcknowledgement(decision.requestId)) return;
  if (!decision.accepted) { runtime.mcp.completeShowAcknowledgement(decision.requestId, 'rejected', decision.rejection); return; }
  try { await createWindow(); runtime.mcp.completeShowAcknowledgement(decision.requestId, 'accepted'); }
  catch { runtime.mcp.completeShowAcknowledgement(decision.requestId, 'rejected', 'window-error'); }
}
async function initialize(): Promise<void> {
  if (!shouldInitializePrimary(startupRequest)) {
    shutdownComplete = true;
    app.quit();
    return;
  }

  const root = app.getAppPath();
  runtime = new EngineRuntime({
    userDataPath: app.getPath('userData'),
    profileId: profileIdForPath(app.getPath('userData')),
    appVersion: app.getVersion(),
    nativeAudioBinary: app.isPackaged
      ? join(process.resourcesPath, 'native', nativeExecutableName('aimuse-audio'))
      : join(root, 'native', process.platform === 'win32' ? 'build' : `build-${process.platform}-${process.arch}`, nativeExecutableName('aimuse-audio')),
    pluginScannerBinary: app.isPackaged
      ? join(process.resourcesPath, 'native', nativeExecutableName('aimuse-plugin-scanner'))
      : join(root, 'native', process.platform === 'win32' ? 'build' : `build-${process.platform}-${process.arch}`, nativeExecutableName('aimuse-plugin-scanner')),
    playbackRenderWorker: join(__dirname, 'playback-render-worker.js'),
    mode: headless ? 'headless' : 'interactive',
  });

  if (authorityPolicyPath || trustedFolders.length) {
    let policy: AuthorityPolicy;
    if (authorityPolicyPath) {
      if (!isAbsolute(authorityPolicyPath)) throw new Error('--authority-policy must be an absolute path.');
      policy = JSON.parse(await readFile(authorityPolicyPath, 'utf8')) as AuthorityPolicy;
    } else {
      const issuedAt = new Date();
      policy = {
        version: 1,
        id: `launch-${process.pid}`,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000).toISOString(),
        maxRuntimeMinutes: 24 * 60,
        readRoots: [],
        writeRoots: [],
        overwritePaths: [],
        pluginAllowlist: [],
        allowMicrophone: false,
        allowMidiInput: false,
        allowMidiOutput: false,
      };
    }
    for (const folder of trustedFolders) {
      if (!isAbsolute(folder)) throw new Error('--trust-folder values must be absolute.');
      policy.readRoots.push(resolve(folder));
      policy.writeRoots.push(resolve(folder));
    }
    const installed = await runtime.authority.install(policy);
    if (!installed.installed) throw new Error(installed.reason);
  }

  await runtime.start();
  const startupMcp = runtime.projects.getMcpInfo();
  if (headless && !startupMcp.running) {
    const status = 'mcp-listener-unavailable: MCP listener failed to start; no engine-lifetime connection authority was exported.';
    process.stderr.write(`AIMuse headless startup failed closed: ${status}\n`);
    await runtime.stop();
    shutdownComplete = true;
    app.exit(1);
    return;
  }
  runtime.projects.on('event', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.event, event);
  });
  registerIpc();
  createMenu();

  if (connectionFile) {
    if (!isAbsolute(connectionFile)) throw new Error('--write-mcp-connection must be an absolute path.');
    const connection = runtime.mcp.connection();
    if (!connection.url) throw new Error('MCP server did not start.');
    await atomicWriteFile(connectionFile, `${JSON.stringify({
      version: 1,
      url: connection.url,
      token: connection.token,
      authorityLifetime: 'engine',
      activeProjectId: runtime.projects.getActiveProjectId(),
      pid: process.pid,
      instanceId: connection.instanceId,
      profileId: connection.profileId,
      trustedFolders: trustedFolders.map((folder) => resolve(folder)),
    }, null, 2)}\n`);
  }
  if (!headless) await createWindow();
}

if (bridgeBootstrap.failed) {
  process.stderr.write('AIMuse MCP bridge rejected an unsafe or malformed local profile boundary.\n');
  app.exit(1);
} else if (bridgeEntry) {
  void runMcpStdioBridge({ userDataPath: bridgeEntry.targetProfilePath, expectedProfileId: profileIdForPath(bridgeEntry.targetProfilePath) })
    .then(() => app.exit(0), () => { process.stderr.write('AIMuse MCP bridge stopped before it could establish a private engine connection.\n'); app.exit(1); });
} else {
  app.on('web-contents-created', (_event, contents) => { contents.on('will-attach-webview', preventWebviewAttachment); contents.setWindowOpenHandler(denyWindowOpen); });
  if (!hasLock) app.quit(); else { app.on('second-instance', (_event, commandLine, _cwd, data) => { const request = parseSecondInstanceRequest(data, commandLine); void ready?.then(() => !shouldInitializePrimary(startupRequest) ? undefined : request.command === 'quit-engine' ? (shouldAcceptQuit(request.instanceId, runtime.mcp.connection().instanceId) ? requestQuit(false) : undefined) : request.command === 'show' ? requestShow(request) : undefined); }); ready = app.whenReady().then(initialize); app.on('activate', () => void ready?.then(() => shouldInitializePrimary(startupRequest) ? createWindow() : undefined)); app.on('window-all-closed', () => { /* The editor is an attachable client; the canonical engine stays alive. */ }); app.on('before-quit', (event) => { if (!shutdownComplete) { event.preventDefault(); void requestQuit(); } }); }
}
