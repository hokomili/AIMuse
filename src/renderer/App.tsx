import { useEffect, useState } from 'react';
import {
  Activity, AudioLines, Bot, ChevronDown, Circle, Cpu, FolderOpen, Gauge, HardDriveDownload,
  KeyboardMusic, Layers3, ListMusic, Menu, Pause, Play, Plus, Radio, Redo2, Save, SaveAll,
  SkipBack, SlidersHorizontal, Sparkles, Square, Undo2, Volume2, X, Zap,
} from 'lucide-react';
import type { BuiltinDeviceKind, ProjectKind, SfxDeliverable, Track, TrackKind } from '@aimuse/core';
import { AGENT_CLIENTS, agentClientDescriptor, type AgentClientId, type AgentClientSetupResult } from '../common/agent-clients';
import type { EngineStatus, TimelineSelection } from '../common/contracts';
import { BottomDock, type DockView } from './BottomDock';
import { CommitNumberInput } from './CommitControls';
import { LeftBrowser, RightSidebar, type BrowserTab, type RightTab } from './Sidebars';
import { Timeline } from './Timeline';
import { barBeat, entity, formatTime, makeBuiltinDevice, makeMidiClip, makeTrack, transaction } from './editor-helpers';
import { useWorkspace } from './use-workspace';

const trackKinds: Array<{ kind: TrackKind; label: string; detail: string; icon: typeof AudioLines }> = [
  { kind: 'audio', label: 'Audio track', detail: 'Record or arrange audio', icon: AudioLines },
  { kind: 'instrument', label: 'Instrument track', detail: 'MIDI with an instrument', icon: KeyboardMusic },
  { kind: 'midi', label: 'External MIDI', detail: 'Route to MIDI hardware', icon: ListMusic },
  { kind: 'folder', label: 'Folder', detail: 'Group related tracks', icon: Layers3 },
  { kind: 'aux', label: 'Return / bus', detail: 'Sends and submixes', icon: SlidersHorizontal },
];

export function App() {
  const workspace = useWorkspace();
  const apply = workspace.apply;
  const snapshot = workspace.snapshot;
  const project = snapshot?.activeProject;
  const [selection, setSelection] = useState<TimelineSelection>();
  const [browserTab, setBrowserTab] = useState<BrowserTab>('media');
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  const [dockView, setDockView] = useState<DockView>('piano');
  const [dockHeight, setDockHeight] = useState(286);
  const [pixelsPerBar, setPixelsPerBar] = useState(108);
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [trackMenu, setTrackMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [newDialog, setNewDialog] = useState<ProjectKind>();
  const [agentDialog, setAgentDialog] = useState(false);
  const [agentClient, setAgentClient] = useState<AgentClientId>('codex');
  const [agentSetup, setAgentSetup] = useState<AgentClientSetupResult>();
  const [agentSetupPending, setAgentSetupPending] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [engine, setEngine] = useState<EngineStatus>();

  useEffect(() => {
    void window.aimuse.getEngineStatus().then(setEngine).catch(() => undefined);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      const textEditing = target instanceof HTMLTextAreaElement
        || (target instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(target.type))
        || (target instanceof HTMLElement && target.isContentEditable);
      const primaryModifier = event.ctrlKey || event.metaKey;
      const historyKey = event.key.toLowerCase();

      if (event.key === 'Escape' || event.code === 'Escape') {
        setTrackMenu(false); setExportMenu(false); setNewDialog(undefined); setAgentDialog(false); setAgentSetup(undefined); setNewName('');
      }
      if (primaryModifier && !event.altKey && !textEditing && (historyKey === 'z' || historyKey === 'y')) {
        event.preventDefault();
        const redo = historyKey === 'y' || event.shiftKey;
        const history = redo ? window.aimuse.redo(project?.id) : window.aimuse.undo(project?.id);
        void history.catch((cause) => workspace.notify(cause instanceof Error ? cause.message : String(cause), 'warning'));
        return;
      }
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); void window.aimuse.transport(snapshot?.transport.status === 'playing' ? 'pause' : 'play').catch((cause) => workspace.notify(cause instanceof Error ? cause.message : String(cause), 'warning')); }
      if (!primaryModifier && !event.altKey && event.key.toLowerCase() === 'm' && project) void apply(transaction(project, 'Toggle metronome', [{ kind: 'project.settings.update', changes: { metronomeEnabled: !project.settings.metronomeEnabled } }]));
      if (!primaryModifier && !event.altKey && event.key.toLowerCase() === 'b') setDockView('piano');
      if (!primaryModifier && !event.altKey && event.key.toLowerCase() === 'a') setDockView('automation');
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [apply, project, snapshot?.transport.status, workspace]);

  if (workspace.loading) return <div className="launch-screen"><div className="brand-mark"><AudioLines /></div><strong>AIMuse</strong><span>Starting the canonical engine…</span><i /></div>;
  if (workspace.error) return <div className="fatal-screen"><Zap size={34} /><h1>The AIMuse engine did not start</h1><p>{workspace.error}</p><button onClick={() => void workspace.refresh()}>Try again</button></div>;
  if (!snapshot) return null;

  const activeTrack = project && selection?.trackIds[0] ? project.tracks[selection.trackIds[0]] : undefined;
  const bpm = project ? project.tempoEvents[project.tempoOrder[0]]?.bpm ?? 120 : 120;
  const meter = project ? project.timeSignatureEvents[project.timeSignatureOrder[0]] : undefined;
  const waitingApprovals = snapshot.jobs.filter((job) => job.status === 'waiting-for-user').length;
  const selectedAgentDescriptor = agentClientDescriptor(agentClient);

  const perform = async <T,>(action: () => Promise<T>, onSuccess?: (value: T) => void): Promise<T | undefined> => {
    try {
      const value = await action(); onSuccess?.(value); return value;
    } catch (cause) {
      workspace.notify(cause instanceof Error ? cause.message : String(cause), 'warning');
      return undefined;
    }
  };

  const loadSelectedAgentSettings = async () => {
    setAgentSetupPending(true);
    try {
      const result = await perform(() => window.aimuse.getAgentClientSettings(agentClient));
      if (!result) return;
      setAgentSetup(result);
      workspace.notify(`${result.clientName} one-time setup is ready`);
    } finally {
      setAgentSetupPending(false);
    }
  };

  const setSelectionAndDock = (next?: TimelineSelection) => {
    setSelection(next);
    const clipId = next?.clipIds[0];
    const clip = clipId ? project?.clips[clipId] : undefined;
    if (clip?.kind === 'midi') setDockView('piano');
    if (clip?.kind === 'audio') setDockView('audio');
  };

  const toggleTrack = (track: Track, field: 'mute' | 'solo' | 'armed') => {
    if (!project) return;
    void apply(transaction(project, `${field === 'armed' ? 'Arm' : field === 'mute' ? 'Mute' : 'Solo'} ${track.name}`, [{ kind: 'track.update', trackId: track.id, changes: { [field]: !track[field] }, expectedRevision: track.revision }]));
  };

  const toggleTrackCollapse = (track: Track) => {
    if (!project) return;
    void apply(transaction(project, `${track.collapsed ? 'Expand' : 'Collapse'} ${track.name}`, [{ kind: 'track.update', trackId: track.id, changes: { collapsed: !track.collapsed }, expectedRevision: track.revision }]));
  };

  const addTrack = (kind: TrackKind) => {
    if (!project) return;
    const track = makeTrack(project, kind);
    const operations: Parameters<typeof transaction>[2] = [{ kind: 'track.add', track, index: Math.max(0, project.trackOrder.length - 1) }];
    if (kind === 'instrument') operations.push({ kind: 'device.add', device: makeBuiltinDevice(track.id, 'subtractive-synth') });
    void apply(transaction(project, `Add ${track.name}`, operations)).then((done) => {
      if (done) setSelectionAndDock({ trackIds: [track.id], clipIds: [] });
    });
    setTrackMenu(false);
  };

  const addMidiClip = (preferredTrackId?: string, preferredStartTick?: number) => {
    if (!project) return;
    const preferredTrack = preferredTrackId ? project.tracks[preferredTrackId] : undefined;
    let track = preferredTrack?.kind === 'instrument' ? preferredTrack : activeTrack?.kind === 'instrument' ? activeTrack : Object.values(project.tracks).find((candidate) => candidate.kind === 'instrument');
    const operations: Parameters<typeof transaction>[2] = [];
    if (!track) {
      track = makeTrack(project, 'instrument', 'New instrument');
      operations.push({ kind: 'track.add', track, index: Math.max(0, project.trackOrder.length - 1) }, { kind: 'device.add', device: makeBuiltinDevice(track.id, 'subtractive-synth') });
    }
    const clip = makeMidiClip(track.id, preferredStartTick ?? Math.round(snapshot.transport.tick / 960) * 960);
    operations.push({ kind: 'clip.add', clip });
    void apply(transaction(project, 'Create MIDI clip', operations)).then((done) => {
      if (done) setSelectionAndDock({ trackIds: [track!.id], clipIds: [clip.id], startTick: clip.startTick, endTick: clip.startTick + clip.durationTicks });
    });
  };

  const browseDevices = (trackId: string) => {
    if (!project) return;
    const track = project.tracks[trackId]; if (!track) return;
    setSelectionAndDock({ trackIds: [track.id], clipIds: [] });
    void perform(() => window.aimuse.updateSelection({ trackIds: [track.id], clipIds: [] }));
    setBrowserTab(track.kind === 'instrument' && track.deviceIds.length === 0 ? 'instruments' : 'effects');
    setLeftVisible(true);
  };

  const addDevice = (kind: BuiltinDeviceKind) => {
    if (!project) return;
    const target = activeTrack && !['folder', 'midi'].includes(activeTrack.kind) ? activeTrack : Object.values(project.tracks).find((track) => track.kind === 'instrument' || track.kind === 'audio');
    if (!target) { workspace.notify('Select an audio, instrument, aux, or master track first.', 'warning'); return; }
    const device = makeBuiltinDevice(target.id, kind);
    void apply(transaction(project, `Add ${device.name}`, [{ kind: 'device.add', device }])).then((done) => done && setRightTab('inspector'));
  };

  const changeTempo = (value: number) => {
    if (!project) return;
    const event = project.tempoEvents[project.tempoOrder[0]];
    if (!event || !Number.isFinite(value) || value < 20 || value > 999) return;
    void apply(transaction(project, 'Change tempo', [{ kind: 'tempo.upsert', event: { ...event, bpm: value }, expectedRevision: event.revision }]));
  };

  const toggleMetronome = () => {
    if (!project) return;
    void apply(transaction(project, 'Toggle metronome', [{ kind: 'project.settings.update', changes: { metronomeEnabled: !project.settings.metronomeEnabled } }]));
  };

  const cycleCountIn = () => {
    if (!project) return;
    const values = [0, 1, 2, 4]; const current = values.indexOf(project.settings.countInBars); const countInBars = values[(current + 1) % values.length];
    void apply(transaction(project, 'Change count-in', [{ kind: 'project.settings.update', changes: { countInBars } }]));
  };

  const createCheckpoint = () => {
    if (!project) return;
    const name = `Checkpoint ${Object.keys(project.checkpoints).length + 1}`;
    void perform(() => window.aimuse.createCheckpoint(project.id, name), () => workspace.notify(`${name} created`, 'success'));
  };

  const createSfxDeliverable = () => {
    if (!project) return;
    const selectedClip = selection?.clipIds[0] ? project.clips[selection.clipIds[0]] : undefined;
    const startTick = selection?.startTick ?? selectedClip?.startTick ?? Math.max(0, Math.round(snapshot.transport.tick));
    const endTick = selection?.endTick ?? (selectedClip ? selectedClip.startTick + selectedClip.durationTicks : startTick + project.settings.ppq * 2);
    const number = Object.keys(project.sfxDeliverables).length + 1;
    const deliverable: SfxDeliverable = {
      ...entity('sfx-deliverable'), name: `SFX ${number}`, startTick, endTick: Math.max(startTick + 1, endTick), variantCount: 3,
      tags: [], seamlessLoop: false, tailMilliseconds: 200,
      variation: { seed: number, pitchRangeSemitones: 1, gainRangeDb: 1.5, timingRangeMilliseconds: 12 },
      targetLufs: -16, namingTemplate: '{project}_{name}_{index}', exportFormat: 'wav',
    };
    void apply(transaction(project, `Create ${deliverable.name}`, [{ kind: 'sfx-deliverable.add', deliverable }])).then((done) => {
      if (done) { setBrowserTab('sfx'); setLeftVisible(true); workspace.notify(`${deliverable.name} created from the selected range`, 'success'); }
    });
  };

  const exportProject = (kind: 'master' | 'stems' | 'midi' | 'dawproject' | 'sfx-batch' | 'pack', format?: 'wav' | 'flac' | 'mp3') => {
    if (!project) return;
    setExportMenu(false);
    void perform(() => window.aimuse.exportProject({ projectId: project.id, kind, format }), (result) => {
      if (result.exported) { workspace.notify(`Export started: ${result.destination}`, 'success'); setRightTab('jobs'); }
      else if (result.warnings[0]) workspace.notify(result.warnings[0], 'warning');
    });
  };

  const openProjects = () => void perform(() => window.aimuse.openProjects(), (result) => { if (result.warnings[0]) workspace.notify(result.warnings.join(' '), 'warning'); });
  const saveActiveProject = () => void perform(() => window.aimuse.saveProject(project?.id), (result) => { if (result.saved) workspace.notify('Project saved', 'success'); else if (result.warnings[0]) workspace.notify(result.warnings.join(' '), 'warning'); });
  const saveActiveProjectAs = () => void perform(() => window.aimuse.saveProjectAs(project?.id), (result) => { if (result.saved) workspace.notify(`Project saved as ${result.projectPath ?? 'a new working folder'}`, 'success'); else if (result.warnings[0]) workspace.notify(result.warnings.join(' '), 'warning'); });
  const closeProject = (projectId: string) => void perform(() => window.aimuse.closeProject(projectId), (result) => { if (!result.closed && result.reason && !/cancelled/i.test(result.reason)) workspace.notify(result.reason, 'warning'); });
  const importMedia = () => { if (project) void perform(() => window.aimuse.importMedia(project.id), (result) => { if (result.imported) workspace.notify(`Imported ${result.imported} media file${result.imported === 1 ? '' : 's'}`, 'success'); if (result.warnings[0]) workspace.notify(result.warnings.join(' '), 'warning'); }); };
  const transport = (action: 'play' | 'pause' | 'stop' | 'seek' | 'loop', options?: { tick?: number; loopEnabled?: boolean }) => void perform(() => window.aimuse.transport(action, options));

  return <div className={`app-shell ${leftVisible ? '' : 'left-hidden'} ${rightVisible ? '' : 'right-hidden'}`}>
    <header className="titlebar">
      <div className="app-brand"><span className="brand-mark"><AudioLines size={18} /></span><strong>AIMuse</strong><small>alpha</small></div>
      <nav className="document-tabs" aria-label="Open projects" role="tablist">{snapshot.projects.map((tab) => <div key={tab.id} className={`document-tab ${snapshot.activeProjectId === tab.id ? 'active' : ''}`}><button className="tab-activate" role="tab" aria-selected={snapshot.activeProjectId === tab.id} onClick={() => void perform(() => window.aimuse.activateProject(tab.id))}><span className={`project-kind ${tab.kind}`}><Music2Icon kind={tab.kind} /></span><span>{tab.name}</span>{tab.dirty && <i />}</button><button className="tab-close" aria-label={`Close ${tab.name}`} onClick={() => closeProject(tab.id)}><X size={12} /></button></div>)}<button className="new-tab" onClick={() => setNewDialog('song')} title="New project"><Plus size={15} /></button></nav>
      <div className="title-actions"><button onClick={openProjects} title="Open"><FolderOpen size={15} /></button><button onClick={saveActiveProject} disabled={!project} title="Save"><Save size={15} /></button><button onClick={saveActiveProjectAs} disabled={!project} title="Save As" aria-label="Save As"><SaveAll size={15} /></button><button onClick={() => { if (project) { setRightVisible(true); setRightTab('agents'); } else setAgentDialog(true); }} className={snapshot.mcp.sessions.length ? 'agents-active' : ''}><Bot size={15} /><span>{snapshot.mcp.sessions.length || 'Agents'}</span></button><button onClick={() => void perform(() => window.aimuse.showApplicationMenu())} title="Application menu"><Menu size={16} /></button></div>
    </header>

    <section className="transport-bar" aria-label="Transport">
      <div className="history-controls"><button disabled={!snapshot.canUndo} onClick={() => void perform(() => window.aimuse.undo(project?.id))} title="Undo"><Undo2 size={15} /></button><button disabled={!snapshot.canRedo} onClick={() => void perform(() => window.aimuse.redo(project?.id))} title="Redo"><Redo2 size={15} /></button><span /><button className={leftVisible ? 'active' : ''} onClick={() => setLeftVisible((visible) => !visible)} title="Toggle browser"><Layers3 size={15} /></button></div>
      <div className="transport-controls"><button onClick={() => transport('seek', { tick: 0 })} title="Return to start"><SkipBack size={16} /></button><button onClick={() => transport(snapshot.transport.status === 'playing' ? 'pause' : 'play')} className="transport-play" title="Play / pause">{snapshot.transport.status === 'playing' ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button onClick={() => transport('stop')} title="Stop"><Square size={13} fill="currentColor" /></button><button disabled title="Recording input is not available in this alpha build"><Circle size={15} fill="currentColor" /></button></div>
      <div className="position-display"><strong>{barBeat(snapshot.transport.tick)}</strong><span>{formatTime(snapshot.transport.tick, bpm)}</span></div>
      <div className="tempo-display"><label>Tempo<CommitNumberInput value={bpm} min={20} max={999} onCommit={changeTempo} disabled={!project} /></label><label>Meter<strong>{meter ? `${meter.numerator}/${meter.denominator}` : '4/4'}</strong></label></div>
      <div className="transport-toggles"><button className={snapshot.transport.loopEnabled ? 'active' : ''} onClick={() => transport('loop', { loopEnabled: !snapshot.transport.loopEnabled })} title="Loop">↻</button><button className={project?.settings.metronomeEnabled ? 'active' : ''} onClick={toggleMetronome} title="Metronome"><Radio size={15} /></button><button onClick={cycleCountIn} title="Cycle count-in">{project?.settings.countInBars ? `${project.settings.countInBars} bar${project.settings.countInBars === 1 ? '' : 's'}` : 'Off'}</button></div>
      <div className="engine-readouts"><span title="CPU callback budget"><Cpu size={13} /><strong>{Math.round(snapshot.transport.cpuLoad * 100)}%</strong></span><span title="Round-trip latency"><Gauge size={13} /><strong>{Math.round(snapshot.transport.latencySamples / (project?.settings.sampleRate ?? 48_000) * 1_000)} ms</strong></span><span className={`engine-state ${engine?.audio.connected ? 'connected' : 'fallback'}`}><i />{engine?.audio.mode === 'native' ? engine.audio.driver.toUpperCase() : 'OFFLINE'}</span></div>
      <div className="right-toggle"><button className={waitingApprovals ? 'needs-attention' : ''} onClick={() => { setRightVisible((visible) => !visible); if (waitingApprovals) setRightTab('jobs'); }}><Activity size={15} />{waitingApprovals > 0 && <em>{waitingApprovals}</em>}</button></div>
    </section>

    {project ? <>
      <section className="project-toolbar"><div className="project-mode"><span className="active"><Music2Icon kind={project.kind} />{project.kind === 'song' ? 'Song' : 'SFX'}</span></div><div className="editing-actions"><div className="popover-anchor"><button onClick={() => setTrackMenu((open) => !open)}><Plus size={14} /> Track <ChevronDown size={12} /></button>{trackMenu && <div className="track-menu popover">{trackKinds.map(({ kind, label, detail, icon: Icon }) => <button key={kind} onClick={() => addTrack(kind)}><Icon size={16} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}</div>}</div><button onClick={() => addMidiClip()}><KeyboardMusic size={14} /> MIDI clip</button>{project.kind === 'sfx' && <button onClick={createSfxDeliverable}><Zap size={14} /> Deliverable</button>}<button onClick={importMedia}><HardDriveDownload size={14} /> Import</button></div><span className="toolbar-spacer" /><button onClick={createCheckpoint}>Checkpoint</button><div className="popover-anchor"><button className="primary subtle" onClick={() => setExportMenu((open) => !open)}>Export <ChevronDown size={12} /></button>{exportMenu && <div className="export-menu popover"><button onClick={() => exportProject('master', 'wav')}><Volume2 size={15} /><span><strong>Master</strong><small>WAV loudness-targeted render</small></span></button><button onClick={() => exportProject('stems', 'wav')}><Layers3 size={15} /><span><strong>Stems</strong><small>One file per track or bus</small></span></button><button onClick={() => exportProject('midi')}><ListMusic size={15} /><span><strong>MIDI</strong><small>Standard MIDI File</small></span></button><button onClick={() => exportProject('dawproject')}><PackageOpenIcon /><span><strong>DAWproject</strong><small>Open interchange with fallback report</small></span></button>{project.kind === 'sfx' && <button onClick={() => exportProject('sfx-batch', 'wav')}><Zap size={15} /><span><strong>SFX batch</strong><small>Deliverables and variants</small></span></button>}<button onClick={() => exportProject('pack')}><HardDriveDownload size={15} /><span><strong>Portable pack</strong><small>ZIP64 .aimusepack</small></span></button></div>}</div></section>
      <main className="studio-layout">
        {leftVisible && <LeftBrowser project={project} jobs={snapshot.jobs} plugins={snapshot.plugins} tab={browserTab} onTab={setBrowserTab} onImport={importMedia} onAddDevice={addDevice} onScanPlugins={() => void perform(() => window.aimuse.scanPlugins(), () => { setRightVisible(true); setRightTab('jobs'); })} onApply={apply} onCreateSfx={createSfxDeliverable} notify={workspace.notify} />}
        <div className="center-workspace"><Timeline project={project} transport={snapshot.transport} selection={selection} agents={snapshot.mcp.sessions} pixelsPerBar={pixelsPerBar} onPixelsPerBar={setPixelsPerBar} onSelection={setSelectionAndDock} onApply={apply} onTrackToggle={toggleTrack} onTrackCollapse={toggleTrackCollapse} onCreateMidiClip={addMidiClip} onOpenInspector={() => { setRightVisible(true); setRightTab('inspector'); }} notify={workspace.notify} /><BottomDock project={project} selection={selection} view={dockView} height={dockHeight} onView={setDockView} onHeight={setDockHeight} onApply={apply} selectedNoteId={selectedNoteId} onSelectNote={setSelectedNoteId} onBrowseDevices={browseDevices} notify={workspace.notify} /></div>
        {rightVisible && <RightSidebar project={project} selection={selection} jobs={snapshot.jobs} mcp={snapshot.mcp} tab={rightTab} onTab={setRightTab} onApply={apply} onResolveJob={(jobId, decision) => void perform(() => window.aimuse.resolveJob(jobId, decision))} onCancelJob={(jobId) => void perform(() => window.aimuse.cancelJob(jobId))} onCheckpoint={createCheckpoint} onRestoreCheckpoint={(checkpointId) => void perform(() => window.aimuse.restoreCheckpoint(project.id, checkpointId), (result) => { if (result.status !== 'committed') workspace.notify(result.message ?? `Checkpoint was not restored (${result.status})`, 'warning'); })} onStopAgents={() => void perform(() => window.aimuse.stopAgents(project.id), (count) => workspace.notify(`Stopped ${count} agent job${count === 1 ? '' : 's'}`))} onConnectAgent={() => { setAgentSetup(undefined); setAgentDialog(true); }} onBrowseDevices={browseDevices} notify={workspace.notify} />}
      </main>
    </> : <Welcome onNew={(kind) => setNewDialog(kind)} onOpen={openProjects} onAgents={() => setAgentDialog(true)} />}

    {newDialog && <div className="modal-backdrop" onPointerDown={() => setNewDialog(undefined)}><form className="new-project-dialog" onSubmit={(event) => { event.preventDefault(); void workspace.createProject(newDialog, newName.trim() || undefined); setNewDialog(undefined); setNewName(''); }} onPointerDown={(event) => event.stopPropagation()}><button type="button" className="modal-close" onClick={() => setNewDialog(undefined)}><X size={16} /></button><span className={`new-project-icon ${newDialog}`}>{newDialog === 'song' ? <Music2Icon kind="song" /> : <Zap size={24} />}</span><h2>New {newDialog === 'song' ? 'Song' : 'SFX Project'}</h2><p>{newDialog === 'song' ? 'Compose, arrange, edit, mix, and master in one project.' : 'Layer, vary, process, tag, and batch-export production-ready sounds.'}</p><label>Project name<input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={newDialog === 'song' ? 'Untitled Song' : 'Untitled SFX'} /></label><div className="template-summary"><span><strong>48 kHz</strong> sample rate</span><span><strong>32-bit float</strong> engine</span><span><strong>960 PPQ</strong> timeline</span></div><div className="modal-actions"><button type="button" onClick={() => setNewDialog(undefined)}>Cancel</button><button type="submit" className="primary">Create project</button></div></form></div>}
    {agentDialog && <div className="modal-backdrop" onPointerDown={() => { setAgentDialog(false); setAgentSetup(undefined); }}><section className="agent-connect-dialog" onPointerDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => { setAgentDialog(false); setAgentSetup(undefined); }}><X size={16} /></button><span className="new-project-icon song"><Bot size={23} /></span><h2>Connect an external agent</h2><p>Add AIMuse to your MCP client once. The static stdio bridge derives verified isolated app state, waits for AIMuse, and reconnects to each fresh engine automatically—no browser-state switch, token copy, settings revisit, password, or protected-secret store.</p><label>MCP client<select autoFocus value={agentClient} onChange={(event) => { setAgentClient(event.target.value as AgentClientId); setAgentSetup(undefined); }}>{AGENT_CLIENTS.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label><label>Connection behavior<code>Automatic after AIMuse launches</code></label><label>Engine authority<code>Internal · fresh on every engine start</code></label>{agentSetup && <div className={`agent-setup-result ${agentSetup.status}`}><strong>{agentSetup.clientName} · one-time setup</strong><p>{agentSetup.message}</p>{agentSetup.restartRequired && <small>{agentSetup.restartInstruction}</small>}<pre>{agentSetup.setupSnippet}</pre><button onClick={() => void navigator.clipboard.writeText(agentSetup.setupSnippet).then(() => workspace.notify('One-time setup copied')).catch((cause) => workspace.notify(`Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`, 'warning'))}>Copy one-time setup</button><code className="agent-docs-url">{agentSetup.documentationUrl}</code></div>}<div className="modal-actions"><button className="primary" disabled={agentSetupPending} onClick={() => void loadSelectedAgentSettings()}>{agentSetupPending ? 'Preparing…' : `Show ${selectedAgentDescriptor.name} one-time setup`}</button></div></section></div>}
    {workspace.toast && <div className={`toast ${workspace.toast.tone}`} key={workspace.toast.id}>{workspace.toast.tone === 'success' ? <CheckIcon /> : workspace.toast.tone === 'warning' ? <Zap size={14} /> : <Activity size={14} />}<span>{workspace.toast.message}</span></div>}
  </div>;
}

function Welcome({ onNew, onOpen, onAgents }: { onNew(kind: ProjectKind): void; onOpen(): void; onAgents(): void }) {
  return <main className="welcome"><div className="welcome-glow one" /><div className="welcome-glow two" /><section className="welcome-copy"><span className="welcome-kicker"><Sparkles size={14} /> Agent-native music studio</span><h1>Make sound.<br /><em>Together.</em></h1><p>A full music and sound-design workspace where you stay hands-on—or let trusted agents carry an idea from brief to finished master.</p><div className="welcome-actions"><button className="primary" onClick={() => onNew('song')}><Music2Icon kind="song" /> New song</button><button onClick={() => onNew('sfx')}><Zap size={16} /> New SFX project</button><button onClick={onOpen}><FolderOpen size={16} /> Open project</button></div><div className="welcome-assurance"><span><i />Local-first projects</span><span><i />Human-priority locks</span><span><i />Every agent edit attributed</span></div></section><section className="welcome-modes"><article><span className="mode-icon autonomous"><Bot size={23} /></span><div><small>WORKFLOW 01</small><h2>Autonomous</h2><p>Give an external agent a brief and a bounded authority policy. It can compose, audition, iterate, mix, and export while AIMuse checkpoints and journals every edit.</p><button onClick={onAgents}>Connect an agent →</button></div><div className="mini-arrangement"><div className="mini-ruler"><i /><i /><i /><i /></div>{['#8b5cf6', '#18b6a4', '#ef6f91', '#f59e0b'].map((color, i) => <div key={color}><span style={{ background: color }} /><i style={{ background: color, width: `${44 + i * 9}%`, marginLeft: `${i * 5}%` }} /></div>)}<em><Bot size={10} /> Agent shaping chorus</em></div></article><article><span className="mode-icon together"><Radio size={23} /></span><div><small>WORKFLOW 02</small><h2>Work together</h2><p>Edit the same project live. Your gestures take priority, while agents see the active range, work around you, and leave colorful, undoable contributions.</p><button onClick={() => onNew('song')}>Start creating →</button></div><div className="mini-collaboration"><span className="human-cursor">You</span><span className="agent-cursor"><Bot size={10} /> Muse agent</span><div /><i /><i /><i /></div></article></section></main>;
}

function Music2Icon({ kind }: { kind: ProjectKind }) { return kind === 'song' ? <Music2Local /> : <Zap size={14} />; }
function Music2Local() { return <ListMusic size={14} />; }
function PackageOpenIcon() { return <HardDriveDownload size={15} />; }
function CheckIcon() { return <span className="toast-check">✓</span>; }
