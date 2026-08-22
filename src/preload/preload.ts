import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AIMuseDesktopAPI, type WorkspaceEvent } from '../common/contracts';

const api: AIMuseDesktopAPI = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  newProject: (options) => ipcRenderer.invoke(IPC.newProject, options),
  activateProject: (projectId) => ipcRenderer.invoke(IPC.activateProject, projectId),
  applyTransaction: (transaction) => ipcRenderer.invoke(IPC.applyTransaction, transaction),
  undo: (projectId) => ipcRenderer.invoke(IPC.undo, projectId), redo: (projectId) => ipcRenderer.invoke(IPC.redo, projectId),
  openProjects: () => ipcRenderer.invoke(IPC.openProjects), saveProject: (projectId) => ipcRenderer.invoke(IPC.saveProject, projectId), saveProjectAs: (projectId) => ipcRenderer.invoke(IPC.saveProjectAs, projectId), closeProject: (projectId, force) => ipcRenderer.invoke(IPC.closeProject, projectId, force),
  acquireHumanLock: (request) => ipcRenderer.invoke(IPC.acquireHumanLock, request), refreshHumanLock: (lockId) => ipcRenderer.invoke(IPC.refreshHumanLock, lockId), holdHumanLock: (lockId) => ipcRenderer.invoke(IPC.holdHumanLock, lockId), releaseHumanLock: (lockId) => ipcRenderer.invoke(IPC.releaseHumanLock, lockId),
  updateSelection: (selection) => ipcRenderer.invoke(IPC.updateSelection, selection), transport: (action, options) => ipcRenderer.invoke(IPC.transport, action, options), stopAgents: (projectId) => ipcRenderer.invoke(IPC.stopAgents, projectId),
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus), setEngineStartAtLogin: (enabled) => ipcRenderer.invoke(IPC.engineStartAtLogin, enabled), getAgentClientSettings: (clientId) => ipcRenderer.invoke(IPC.agentClientSettings, clientId),
  showApplicationMenu: () => ipcRenderer.invoke(IPC.showApplicationMenu), mediaUrl: (projectId, assetId) => `aimuse://media/project/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`,
  resolveJob: (jobId, decision) => ipcRenderer.invoke(IPC.resolveJob, jobId, decision), cancelJob: (jobId) => ipcRenderer.invoke(IPC.cancelJob, jobId),
  importMedia: (projectId) => ipcRenderer.invoke(IPC.importMedia, projectId), exportProject: (request) => ipcRenderer.invoke(IPC.exportProject, request),
  createCheckpoint: (projectId, name) => ipcRenderer.invoke(IPC.checkpointCreate, projectId, name), restoreCheckpoint: (projectId, checkpointId) => ipcRenderer.invoke(IPC.checkpointRestore, projectId, checkpointId),
  scanPlugins: () => ipcRenderer.invoke(IPC.scanPlugins), installAuthorityPolicy: (policy) => ipcRenderer.invoke(IPC.installAuthorityPolicy, policy), replayTrace: (projectId, transactionId) => ipcRenderer.invoke(IPC.replayTrace, projectId, transactionId),
  onEvent: (callback) => { const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceEvent) => callback(payload); ipcRenderer.on(IPC.event, listener); return () => ipcRenderer.removeListener(IPC.event, listener); },
  onNewProjectRequested: (callback) => { const listener = (_event: Electron.IpcRendererEvent, kind?: Parameters<typeof callback>[0]) => callback(kind); ipcRenderer.on(IPC.newProjectRequested, listener); return () => ipcRenderer.removeListener(IPC.newProjectRequested, listener); },
};
contextBridge.exposeInMainWorld('aimuse', Object.freeze(api));
