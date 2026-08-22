import { useEffect, useRef, useState } from 'react';
import {
  Activity, AudioLines, Bot, ChevronDown, Clock3, Database, Download,
  FileAudio, FolderKanban, HardDrive, Layers3, Music2, PackageOpen, PlugZap, RefreshCw,
  Search, ShieldAlert, SlidersHorizontal, Square, X,
} from 'lucide-react';
import type { AIMuseProject, AsyncJob, BuiltinDeviceKind, Clip, Device, Marker, MediaAsset, PluginDescriptor, ProjectTransaction, SfxDeliverable, SongSection, Track } from '@aimuse/core';
import type { AgentPresence, McpConnectionInfo, TimelineSelection } from '../common/contracts';
import { CommitNumberInput, CommitRange, CommitTextInput } from './CommitControls';
import { db, entity, transaction } from './editor-helpers';

export type BrowserTab = 'media' | 'instruments' | 'effects' | 'plugins' | 'sfx';
export type RightTab = 'inspector' | 'structure' | 'activity' | 'jobs' | 'agents';

const instruments: Array<{ kind: BuiltinDeviceKind; name: string; detail: string; glyph: string }> = [
  { kind: 'sampler', name: 'Sampler', detail: 'Chromatic sample instrument', glyph: 'S' },
  { kind: 'drum-rack', name: 'Drum Rack', detail: '16-pad drum instrument', glyph: '▦' },
  { kind: 'subtractive-synth', name: 'Muse Synth', detail: 'Two-oscillator subtractive synth', glyph: '∿' },
];
const effects: Array<{ kind: BuiltinDeviceKind; name: string; category: string }> = [
  { kind: 'utility', name: 'Utility', category: 'Utility' }, { kind: 'eq', name: 'Parametric EQ', category: 'Tone' },
  { kind: 'compressor', name: 'Compressor', category: 'Dynamics' }, { kind: 'gate', name: 'Gate', category: 'Dynamics' },
  { kind: 'saturator', name: 'Saturator', category: 'Color' }, { kind: 'chorus', name: 'Chorus', category: 'Modulation' },
  { kind: 'delay', name: 'Delay', category: 'Space' }, { kind: 'reverb', name: 'Algorithmic Reverb', category: 'Space' },
  { kind: 'limiter', name: 'Limiter', category: 'Dynamics' }, { kind: 'analyzer', name: 'Spectrum & Loudness', category: 'Metering' },
];

interface LeftBrowserProps {
  project: AIMuseProject;
  jobs: AsyncJob[];
  plugins: PluginDescriptor[];
  tab: BrowserTab;
  onTab(tab: BrowserTab): void;
  onImport(): void;
  onAddDevice(kind: BuiltinDeviceKind): void;
  onScanPlugins(): void;
  onApply(edit: ProjectTransaction): Promise<boolean>;
  onCreateSfx(): void;
  notify(message: string): void;
}

const browserTabs: Array<{ id: BrowserTab; label: string; icon: typeof FileAudio }> = [
  { id: 'media', label: 'Media', icon: FileAudio },
  { id: 'instruments', label: 'Instruments', icon: Music2 }, { id: 'effects', label: 'Effects', icon: SlidersHorizontal },
  { id: 'plugins', label: 'Plug-ins', icon: PlugZap }, { id: 'sfx', label: 'SFX', icon: Layers3 },
];

function useMediaPreview(notify: (message: string) => void) {
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const [playingId, setPlayingId] = useState<string>();
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = (id: string, url: string) => {
    if (playingId === id && audio.current && !audio.current.paused) { audio.current.pause(); setPlayingId(undefined); return; }
    audio.current?.pause();
    const next = new Audio(url); audio.current = next; setPlayingId(id);
    next.onended = () => setPlayingId((current) => current === id ? undefined : current);
    next.onerror = () => { setPlayingId((current) => current === id ? undefined : current); notify('Audio preview could not be played.'); };
    void next.play().catch((cause) => { setPlayingId(undefined); notify(cause instanceof Error ? cause.message : String(cause)); });
  };
  return { playingId, toggle };
}

function MediaBrowser({ project, onImport, query, playingId, onPreview }: Pick<LeftBrowserProps, 'project' | 'onImport'> & { query: string; playingId?: string; onPreview(id: string, url: string): void }) {
  const [location, setLocation] = useState<'project' | 'cache'>('project');
  const allAssets = Object.values(project.assets).filter((asset) => asset.kind === 'midi' || asset.mimeType.startsWith('audio/'));
  const assets = allAssets.filter((asset) => (location === 'project' || asset.storage === 'managed-cache') && (!query || `${asset.name} ${asset.kind} ${asset.mimeType}`.toLowerCase().includes(query)));
  return <div className="browser-section"><div className="section-heading"><span>Project media</span><button onClick={onImport}>Import</button></div>{assets.length ? assets.map((asset) => <AssetRow key={asset.id} projectId={project.id} asset={asset} playing={playingId === `asset:${asset.id}`} onPreview={onPreview} />) : allAssets.length ? <span className="muted-copy">No media matches this view.</span> : <BrowserEmpty icon={<FileAudio size={25} />} title="No media yet" detail="Drop files into the arrangement or import WAV, FLAC, MP3, AAC, OGG, or MIDI." action="Import media" onAction={onImport} />}<div className="browser-subhead">Locations</div><button className={`location-row ${location === 'project' ? 'active' : ''}`} onClick={() => setLocation('project')}><FolderKanban size={15} /> Project files <span>{allAssets.length}</span></button><button className={`location-row ${location === 'cache' ? 'active' : ''}`} onClick={() => setLocation('cache')}><HardDrive size={15} /> Managed cache <span>{allAssets.filter((asset) => asset.storage === 'managed-cache').length}</span></button></div>;
}

function AssetRow({ projectId, asset, playing, onPreview }: { projectId: string; asset: MediaAsset; playing: boolean; onPreview(id: string, url: string): void }) {
  const duration = asset.durationSamples && asset.sampleRate ? asset.durationSamples / asset.sampleRate : undefined;
  const content = <><span className={`asset-icon ${asset.kind}`}><AudioLines size={15} /></span><span><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} {duration ? `· ${duration.toFixed(1)} s` : ''}</small></span><em>{playing ? '■' : asset.channels ? `${asset.channels}ch` : ''}</em></>;
  return asset.mimeType.startsWith('audio/') ? <button className={`asset-row ${playing ? 'active' : ''}`} onClick={() => onPreview(`asset:${asset.id}`, window.aimuse.mediaUrl(projectId, asset.id))} aria-label={`${playing ? 'Stop' : 'Preview'} ${asset.name}`} aria-pressed={playing} title={playing ? 'Stop preview' : 'Preview audio'}>{content}</button> : <div className="asset-row" title="MIDI is placed in the arrangement when imported">{content}</div>;
}

function DeviceBrowser({ entries, onAdd, query }: { entries: typeof instruments | typeof effects; onAdd(kind: BuiltinDeviceKind): void; query: string }) {
  const filtered = entries.filter((entry) => !query || `${entry.name} ${'detail' in entry ? entry.detail : entry.category}`.toLowerCase().includes(query));
  return <div className="browser-section device-browser"><div className="section-heading"><span>Built into AIMuse</span><small>{filtered.length}</small></div>{filtered.map((entry) => <button className="device-row" key={entry.kind} onClick={(event) => { if (event.detail <= 1) onAdd(entry.kind); }}><span className="device-glyph">{'glyph' in entry ? entry.glyph : <SlidersHorizontal size={15} />}</span><span><strong>{entry.name}</strong><small>{'detail' in entry ? entry.detail : entry.category}</small></span><em>＋</em></button>)}{!filtered.length && <span className="muted-copy">No devices match this search.</span>}<p className="browser-tip">Click to add to the selected track.</p></div>;
}

function PluginBrowser({ plugins, onScanPlugins, query }: Pick<LeftBrowserProps, 'plugins' | 'onScanPlugins'> & { query: string }) {
  const filtered = plugins.filter((plugin) => !query || `${plugin.name} ${plugin.vendor} ${plugin.format}`.toLowerCase().includes(query));
  return <div className="browser-section"><div className="section-heading"><span>VST3 & CLAP</span><button onClick={onScanPlugins}><RefreshCw size={12} /> Scan</button></div>{filtered.length ? filtered.map((plugin) => <div className={`plugin-row ${plugin.quarantined ? 'quarantined' : ''}`} key={plugin.id}><span><PlugZap size={15} /></span><div><strong>{plugin.name}</strong><small>{plugin.vendor} · {plugin.format.toUpperCase()}</small></div>{plugin.quarantined && <ShieldAlert size={14} />}</div>) : plugins.length ? <span className="muted-copy">No plug-ins match this search.</span> : <BrowserEmpty icon={<PlugZap size={25} />} title="No plug-ins scanned" detail="AIMuse scans each plug-in in a disposable process and quarantines crashes or hangs." action="Scan plug-ins" onAction={onScanPlugins} />}</div>;
}

function SfxDeliverableCard({ project, item, onApply }: { project: AIMuseProject; item: SfxDeliverable; onApply(edit: ProjectTransaction): Promise<boolean> }) {
  const [name, setName] = useState(item.name); const [tags, setTags] = useState(item.tags.join(', ')); const [template, setTemplate] = useState(item.namingTemplate);
  const update = (changes: Partial<SfxDeliverable>) => void onApply(transaction(project, `Edit ${item.name}`, [{ kind: 'sfx-deliverable.update', deliverableId: item.id, changes, expectedRevision: item.revision }]));
  return <div className="deliverable-card"><header><span><Layers3 size={15} /></span><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} onBlur={() => name.trim() && name.trim() !== item.name && update({ name: name.trim() })} /><button title="Delete deliverable" onClick={() => void onApply(transaction(project, `Delete ${item.name}`, [{ kind: 'sfx-deliverable.delete', deliverableId: item.id, expectedRevision: item.revision }]))}><X size={12} /></button></header><div className="deliverable-grid"><label>Variants<CommitNumberInput min={1} max={1000} value={item.variantCount} onCommit={(value) => update({ variantCount: value })} /></label><label>Target<CommitNumberInput min={-36} max={-5} step="0.5" value={item.targetLufs} onCommit={(value) => update({ targetLufs: value })} /><em>LUFS</em></label><label>Pitch ±<CommitNumberInput min={0} max={24} step="0.1" value={item.variation.pitchRangeSemitones} onCommit={(value) => update({ variation: { ...item.variation, pitchRangeSemitones: value } })} /><em>st</em></label><label>Timing ±<CommitNumberInput min={0} max={5000} step="1" value={item.variation.timingRangeMilliseconds} onCommit={(value) => update({ variation: { ...item.variation, timingRangeMilliseconds: value } })} /><em>ms</em></label><label>Tail<CommitNumberInput min={0} max={60000} step="10" value={item.tailMilliseconds} disabled={item.seamlessLoop} onCommit={(value) => update({ tailMilliseconds: value })} /><em>ms</em></label><label>Format<select value={item.exportFormat} onChange={(event) => update({ exportFormat: event.target.value as SfxDeliverable['exportFormat'] })}><option value="wav">WAV</option><option value="flac">FLAC</option><option value="mp3">MP3</option></select></label></div><label className="deliverable-text">Tags<input value={tags} onChange={(event) => setTags(event.target.value)} onBlur={() => update({ tags: tags.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 100) })} /></label><label className="deliverable-text">Naming<input value={template} onChange={(event) => setTemplate(event.target.value)} onBlur={() => template.trim() && update({ namingTemplate: template.trim() })} /></label><label className="deliverable-toggle"><input type="checkbox" checked={item.seamlessLoop} onChange={(event) => update({ seamlessLoop: event.target.checked })} /> Seamless loop <small>{item.startTick}–{item.endTick} ticks</small></label></div>;
}

function SfxBrowser({ project, onCreateSfx, onApply, query }: Pick<LeftBrowserProps, 'project' | 'onCreateSfx' | 'onApply'> & { query: string }) {
  const allDeliverables = Object.values(project.sfxDeliverables);
  const deliverables = allDeliverables.filter((item) => !query || `${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(query));
  return <div className="browser-section"><div className="section-heading"><span>Deliverables</span><button onClick={onCreateSfx}>＋ New</button></div>{deliverables.length ? deliverables.map((item) => <SfxDeliverableCard key={`${item.id}:${item.revision}`} project={project} item={item} onApply={onApply} />) : allDeliverables.length ? <span className="muted-copy">No deliverables match this search.</span> : <BrowserEmpty icon={<Layers3 size={25} />} title="No SFX deliverables" detail="Mark timeline ranges for named one-shots, loops, and deterministic randomized batch variations." action="Create from selection" onAction={onCreateSfx} />}</div>;
}

function BrowserEmpty({ icon, title, detail, action, onAction }: { icon: React.ReactNode; title: string; detail: string; action: string; onAction?: () => void }) {
  return <div className="browser-empty"><span>{icon}</span><strong>{title}</strong><p>{detail}</p>{onAction ? <button onClick={onAction}>{action}</button> : <small className="empty-status">{action}</small>}</div>;
}

export function LeftBrowser(props: LeftBrowserProps) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    // A search is scoped to the visible catalog; carrying it into another tab
    // makes a correctly routed Insert action appear to have no results.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery('');
  }, [props.tab]);
  const normalizedQuery = query.trim().toLowerCase();
  const preview = useMediaPreview(props.notify);
  return <aside className="left-browser" aria-label="Studio browser"><nav className="browser-tabs">{browserTabs.map(({ id, label, icon: Icon }) => <button key={id} className={props.tab === id ? 'active' : ''} onClick={() => props.onTab(id)} title={label}><Icon size={17} /><span>{label}</span></button>)}</nav><div className="browser-main"><div className="browser-title"><strong>{browserTabs.find((entry) => entry.id === props.tab)?.label}</strong><span><ChevronDown size={14} /></span></div><label className="browser-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${props.tab}`} aria-label={`Search ${props.tab}`} /></label>{props.tab === 'media' && <MediaBrowser project={props.project} onImport={props.onImport} query={normalizedQuery} playingId={preview.playingId} onPreview={preview.toggle} />}{props.tab === 'instruments' && <DeviceBrowser entries={instruments} onAdd={props.onAddDevice} query={normalizedQuery} />}{props.tab === 'effects' && <DeviceBrowser entries={effects} onAdd={props.onAddDevice} query={normalizedQuery} />}{props.tab === 'plugins' && <PluginBrowser plugins={props.plugins} onScanPlugins={props.onScanPlugins} query={normalizedQuery} />}{props.tab === 'sfx' && <SfxBrowser {...props} query={normalizedQuery} />}</div></aside>;
}

interface RightSidebarProps {
  project: AIMuseProject;
  selection?: TimelineSelection;
  jobs: AsyncJob[];
  mcp: McpConnectionInfo;
  tab: RightTab;
  onTab(tab: RightTab): void;
  onApply: (edit: ProjectTransaction) => Promise<boolean>;
  onResolveJob(jobId: string, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): void;
  onCancelJob(jobId: string): void;
  onCheckpoint(): void;
  onRestoreCheckpoint(checkpointId: string): void;
  onStopAgents(): void;
  onConnectAgent(): void;
  onBrowseDevices(trackId: string): void;
  notify(message: string): void;
}

const rightTabs: Array<{ id: RightTab; label: string; icon: typeof Activity }> = [{ id: 'inspector', label: 'Inspector', icon: SlidersHorizontal }, { id: 'structure', label: 'Song', icon: Music2 }, { id: 'activity', label: 'Activity', icon: Activity }, { id: 'jobs', label: 'Jobs', icon: Clock3 }, { id: 'agents', label: 'Agents', icon: Bot }];

function Inspector({ project, selection, onApply, onBrowseDevices }: Pick<RightSidebarProps, 'project' | 'selection' | 'onApply' | 'onBrowseDevices'>) {
  const track = selection?.trackIds[0] ? project.tracks[selection.trackIds[0]] : undefined;
  const clip = selection?.clipIds[0] ? project.clips[selection.clipIds[0]] : undefined;
  const updateTrack = (changes: Partial<Pick<Track, 'name' | 'gainDb' | 'pan' | 'mute' | 'solo' | 'armed'>>) => track && void onApply(transaction(project, `Edit ${track.name}`, [{ kind: 'track.update', trackId: track.id, changes, expectedRevision: track.revision }]));
  const moveClip = (startTick: number) => clip && void onApply(transaction(project, `Move “${clip.name}”`, [{ kind: 'clip.move', clipId: clip.id, trackId: clip.trackId, startTick: Math.max(0, Math.round(startTick)), expectedRevision: clip.revision }]));
  const trimClip = (durationTicks: number) => clip && void onApply(transaction(project, `Trim “${clip.name}”`, [{ kind: 'clip.trim', clipId: clip.id, startTick: clip.startTick, durationTicks: Math.max(1, Math.round(durationTicks)), ...(clip.kind === 'audio' ? { sourceDurationSamples: Math.max(1, Math.round(clip.sourceDurationSamples * Math.max(1, durationTicks) / clip.durationTicks)) } : {}), expectedRevision: clip.revision }]));
  const splitClip = (target: Clip) => {
    const tick = target.startTick + Math.max(1, Math.floor(target.durationTicks / 2));
    if (tick >= target.startTick + target.durationTicks) return;
    const rightClip = { ...structuredClone(target), ...entity('clip'), name: `${target.name} (right)` } as Clip;
    void onApply(transaction(project, `Split “${target.name}” at midpoint`, [{ kind: 'clip.split', clipId: target.id, tick, rightClip, expectedRevision: target.revision }]));
  };
  if (!track) return <BrowserEmpty icon={<SlidersHorizontal size={25} />} title="Nothing selected" detail="Select a track, clip, note, device, or automation range to inspect it." action="Select in arrangement" />;
  return <div className="inspector"><div className="inspector-object"><span style={{ background: track.color }} /><div><strong>{clip?.name ?? track.name}</strong><small>{clip ? `${clip.kind} clip` : `${track.kind} track`} · r{clip?.revision ?? track.revision}</small></div></div>{clip && <div className="property-group"><div className="property-heading">Clip operations</div><label><span>Start</span><CommitNumberInput aria-label="Clip start tick" min={0} step={120} value={clip.startTick} onCommit={moveClip} /></label><label><span>Length</span><CommitNumberInput aria-label="Clip length ticks" min={1} step={120} value={clip.durationTicks} onCommit={trimClip} /></label><label><span>Gain</span><output>{db(clip.gainDb)}</output></label><label><span>Loop</span><input type="checkbox" checked={clip.loopEnabled} onChange={(event) => void onApply(transaction(project, 'Toggle clip loop', [{ kind: 'clip.update', clipId: clip.id, changes: { loopEnabled: event.target.checked }, expectedRevision: clip.revision }]))} /></label><button className="certifiable-action" onClick={() => splitClip(clip)} disabled={clip.durationTicks < 2} aria-label={`Split ${clip.name} at midpoint`}>Split at midpoint</button><small className="certifiable-hint">Start commits a move; Length commits a trim. Each action is one attributed transaction and can be undone.</small></div>}<div className="property-group"><div className="property-heading">Track</div><label><span>Name</span><CommitTextInput value={track.name} maxLength={200} onCommit={(value) => value.trim() && updateTrack({ name: value.trim() })} /></label><label><span>Volume</span><CommitRange min="-60" max="12" step="0.1" value={track.gainDb} onCommit={(value) => updateTrack({ gainDb: value })} /><output>{db(track.gainDb)}</output></label><label><span>Pan</span><CommitRange min="-1" max="1" step="0.01" value={track.pan} onCommit={(value) => updateTrack({ pan: value })} /><output>{track.pan === 0 ? 'C' : `${Math.round(Math.abs(track.pan) * 100)}${track.pan < 0 ? 'L' : 'R'}`}</output></label></div><div className="property-group"><div className="property-heading">Devices <button onClick={() => onBrowseDevices(track.id)} aria-label={`Add device to ${track.name}`}>＋</button></div>{track.deviceIds.map((deviceId) => { const device = project.devices[deviceId]; return device ? <DeviceCard key={device.id} project={project} device={device} onApply={onApply} /> : null; })}{track.deviceIds.length === 0 && <button className="empty-device-slot" onClick={() => onBrowseDevices(track.id)}>＋ Add instrument or effect</button>}</div></div>;
}

function LyricsEditor({ project, onApply }: Pick<RightSidebarProps, 'project' | 'onApply'>) {
  const [draft, setDraft] = useState(project.lyrics);
  useEffect(() => {
    // A committed project snapshot replaces the local lyrics draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(project.lyrics);
  }, [project.id, project.lyrics]);
  const changed = draft !== project.lyrics;
  return <div className="structure-lyrics"><label htmlFor="song-lyrics">Lyrics</label><textarea id="song-lyrics" value={draft} maxLength={200_000} onChange={(event) => setDraft(event.target.value)} placeholder="Write lyrics, spoken text, or arrangement notes…" /><div><small>{draft.length.toLocaleString()} / 200,000</small><button className="certifiable-action" disabled={!changed} onClick={() => void onApply(transaction(project, 'Set song lyrics', [{ kind: 'lyrics.set', lyrics: draft }]))}>Save lyrics</button></div></div>;
}

function StructurePanel({ project, selection, onApply }: Pick<RightSidebarProps, 'project' | 'selection' | 'onApply'>) {
  const selectionStart = Math.max(0, Math.round(selection?.startTick ?? 0));
  const selectionEnd = Math.max(selectionStart + project.settings.ppq, Math.round(selection?.endTick ?? selectionStart + project.settings.ppq * 4));
  const addMarker = () => {
    const marker: Marker = { ...entity('marker'), tick: selectionStart, name: `Marker ${project.markerOrder.length + 1}`, color: '#14b8a6', kind: 'marker' };
    void onApply(transaction(project, `Add ${marker.name}`, [{ kind: 'marker.add', marker }]));
  };
  const addSection = () => {
    const section: SongSection = { ...entity('section'), name: `Section ${project.sectionOrder.length + 1}`, startTick: selectionStart, endTick: selectionEnd, color: '#f59e0b', energy: 0.5 };
    void onApply(transaction(project, `Add ${section.name}`, [{ kind: 'section.add', section }]));
  };
  const updateMarker = (marker: Marker, changes: Partial<Pick<Marker, 'name' | 'tick' | 'kind'>>) => void onApply(transaction(project, `Edit ${marker.name}`, [{ kind: 'marker.update', markerId: marker.id, changes, expectedRevision: marker.revision }]));
  const updateSection = (section: SongSection, changes: Partial<Pick<SongSection, 'name' | 'startTick' | 'endTick' | 'energy'>>) => void onApply(transaction(project, `Edit ${section.name}`, [{ kind: 'section.update', sectionId: section.id, changes, expectedRevision: section.revision }]));
  return <div className="structure-panel"><div className="structure-summary"><strong>Song structure</strong><small>Selection {selectionStart}–{selectionEnd} ticks</small></div><section><div className="section-heading"><span>Markers</span><button onClick={addMarker}>＋ At selection</button></div>{project.markerOrder.map((id) => { const marker = project.markers[id]; return <div className="structure-row" key={marker.id}><CommitTextInput aria-label={`Marker name ${marker.name}`} value={marker.name} maxLength={200} onCommit={(value) => value.trim() && updateMarker(marker, { name: value.trim() })} /><CommitNumberInput aria-label={`Marker tick ${marker.name}`} min={0} step={120} value={marker.tick} onCommit={(tick) => updateMarker(marker, { tick: Math.round(tick) })} /><select aria-label={`Marker kind ${marker.name}`} value={marker.kind} onChange={(event) => updateMarker(marker, { kind: event.target.value as Marker['kind'] })}><option value="marker">Marker</option><option value="region">Region</option><option value="cue">Cue</option></select><button aria-label={`Delete marker ${marker.name}`} onClick={() => void onApply(transaction(project, `Delete ${marker.name}`, [{ kind: 'marker.delete', markerId: marker.id, expectedRevision: marker.revision }]))}>×</button></div>; })}{!project.markerOrder.length && <p className="muted-copy">No markers. Add one at the selected range start.</p>}</section><section><div className="section-heading"><span>Sections</span><button onClick={addSection}>＋ From selection</button></div>{project.sectionOrder.map((id) => { const section = project.sections[id]; return <div className="structure-section" key={section.id}><div><CommitTextInput aria-label={`Section name ${section.name}`} value={section.name} maxLength={200} onCommit={(value) => value.trim() && updateSection(section, { name: value.trim() })} /><button aria-label={`Delete section ${section.name}`} onClick={() => void onApply(transaction(project, `Delete ${section.name}`, [{ kind: 'section.delete', sectionId: section.id, expectedRevision: section.revision }]))}>×</button></div><label>Start<CommitNumberInput aria-label={`Section start ${section.name}`} min={0} step={120} value={section.startTick} onCommit={(startTick) => startTick < section.endTick && updateSection(section, { startTick: Math.round(startTick) })} /></label><label>End<CommitNumberInput aria-label={`Section end ${section.name}`} min={section.startTick + 1} step={120} value={section.endTick} onCommit={(endTick) => updateSection(section, { endTick: Math.round(endTick) })} /></label><label>Energy<CommitRange aria-label={`Section energy ${section.name}`} min={0} max={1} step={0.05} value={section.energy ?? 0.5} onCommit={(energy) => updateSection(section, { energy })} /></label></div>; })}{!project.sectionOrder.length && <p className="muted-copy">No sections. Create one from the selected timeline range.</p>}</section>{project.kind === 'song' && <LyricsEditor project={project} onApply={onApply} />}</div>;
}

function DeviceCard({ project, device, onApply }: { project: AIMuseProject; device: Device; onApply: RightSidebarProps['onApply'] }) {
  const setParameter = (parameterId: string, value: number) => void onApply(transaction(project, `Set ${device.name} parameter`, [{ kind: 'device.parameter.set', deviceId: device.id, parameterId, value, expectedRevision: device.revision }]));
  return <div className={`device-card ${device.bypassed ? 'bypassed' : ''}`}><div className="device-card-title"><button className={device.bypassed ? '' : 'on'} onClick={() => void onApply(transaction(project, `Toggle ${device.name}`, [{ kind: 'device.update', deviceId: device.id, changes: { bypassed: !device.bypassed }, expectedRevision: device.revision }]))} aria-label={`${device.bypassed ? 'Enable' : 'Bypass'} ${device.name}`} /><strong>{device.name}</strong><small>{device.format}</small><ChevronDown size={12} /></div>{Object.values(device.parameters).slice(0, 4).map((parameter) => <label key={parameter.id}><span>{parameter.name}</span><CommitRange min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 200} value={parameter.value} onCommit={(value) => setParameter(parameter.id, value)} /><output>{parameter.value.toFixed(parameter.max > 100 ? 0 : 2)}{parameter.unit ? ` ${parameter.unit}` : ''}</output></label>)}</div>;
}

function ActivityPanel({ project, onRestoreCheckpoint, onCheckpoint }: Pick<RightSidebarProps, 'project' | 'onRestoreCheckpoint' | 'onCheckpoint'>) {
  const entries = [...project.activity].reverse().slice(0, 80);
  return <div className="activity-panel"><div className="section-heading"><span>Checkpoints</span><button onClick={onCheckpoint}>＋ Save</button></div><div className="checkpoint-strip">{Object.values(project.checkpoints).slice(-4).reverse().map((checkpoint) => <button key={checkpoint.id} onClick={() => onRestoreCheckpoint(checkpoint.id)}><PackageOpen size={14} /><span><strong>{checkpoint.name}</strong><small>Revision {checkpoint.projectRevision}</small></span></button>)}{Object.keys(project.checkpoints).length === 0 && <span className="muted-copy">Broad agent edits create checkpoints automatically.</span>}</div><div className="browser-subhead">Timeline</div>{entries.map((entry) => <div className="activity-entry" key={entry.id}><span className="actor-avatar" style={{ background: entry.actor.color }}>{entry.actor.kind === 'agent' ? <Bot size={12} /> : entry.actor.name[0]}</span><div><strong>{entry.label}</strong><small>{entry.actor.name} · revision {entry.revision}</small></div><time>{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}{!entries.length && <BrowserEmpty icon={<Activity size={24} />} title="No edits yet" detail="Human and agent edits will appear here with durable attribution." action="Start creating" />}</div>;
}

function JobPanel({ jobs, onResolveJob, onCancelJob }: Pick<RightSidebarProps, 'jobs' | 'onResolveJob' | 'onCancelJob'>) {
  const ordered = [...jobs].reverse();
  return <div className="job-panel">{ordered.map((job) => <div className={`job-card ${job.status}`} key={job.id}><header><span className={`job-icon ${job.kind}`}>{job.kind === 'approval' ? <ShieldAlert size={15} /> : job.kind === 'render' ? <Download size={15} /> : <Clock3 size={15} />}</span><div><strong>{job.message}</strong><small>{job.kind} · {job.status.replaceAll('-', ' ')}</small></div><em>{Math.round(job.progress * 100)}%</em></header>{job.status === 'running' && <div className="progress"><i style={{ width: `${job.progress * 100}%` }} /></div>}{job.approval && <div className="approval-card"><p>{job.approval.summary}</p><div><button onClick={() => onResolveJob(job.id, 'deny')}>Deny</button><button onClick={() => onResolveJob(job.id, 'allow-once')}>Allow once</button><button className="primary" onClick={() => onResolveJob(job.id, 'allow-session')}>Allow for session</button></div></div>}{job.error && <p className="job-error">{job.error.message}</p>}{job.cancellable && ['queued', 'running', 'waiting-for-user'].includes(job.status) && <button className="cancel-job" onClick={() => onCancelJob(job.id)}><Square size={10} /> Cancel</button>}</div>)}{!ordered.length && <BrowserEmpty icon={<Clock3 size={24} />} title="No jobs" detail="Renders, analysis, scans, and approval requests appear here." action="Everything is caught up" />}</div>;
}

function AgentsPanel({ mcp, onStopAgents, onConnectAgent }: Pick<RightSidebarProps, 'mcp' | 'onStopAgents' | 'onConnectAgent'>) {
  return <div className="agents-panel"><div className="engine-connection"><span className={mcp.running ? 'connected' : ''}><Database size={17} /></span><div><strong>Agent control server</strong><small>{mcp.running ? 'Private bridge ready' : (mcp.message ?? 'Not running')}</small></div><em>{mcp.running ? 'Private' : 'Offline'}</em></div><div className="connection-field"><label>Client transport</label><div><code>AIMuse stdio bridge</code></div></div><div className="connection-field"><label>Restart behavior</label><div><code>Automatic · no token transfer</code></div></div><button className="configure-agent" onClick={onConnectAgent}><Bot size={15} /> Connect an external agent</button><div className="browser-subhead">Present now · {mcp.sessions.length}</div>{mcp.sessions.map((presence) => <AgentRow presence={presence} key={presence.actor.id} />)}{mcp.sessions.length === 0 && <p className="muted-copy">No external agents are connected. Configured clients can wait for AIMuse and reconnect after engine restarts.</p>}<div className="agent-policy"><ShieldAlert size={14} /><span><strong>Human-priority editing</strong>Human gestures lock affected entities and ranges. Broad agent changes checkpoint first.</span></div><button className="stop-agents" disabled={!mcp.sessions.length} onClick={onStopAgents}><Square size={11} fill="currentColor" /> Stop agents</button></div>;
}

function AgentRow({ presence }: { presence: AgentPresence }) {
  return <div className="agent-row"><span className="actor-avatar" style={{ background: presence.actor.color }}><Bot size={13} /></span><div><strong>{presence.actor.name}</strong><small>{presence.actor.client?.model ?? presence.actor.client?.product ?? 'MCP client'} · {presence.status}</small></div><em className={presence.status}>{presence.queueDepth ? `${presence.queueDepth} queued` : presence.status}</em></div>;
}

export function RightSidebar(props: RightSidebarProps) {
  return <aside className="right-sidebar" aria-label="Inspector and activity"><nav className="right-tabs">{rightTabs.map(({ id, label, icon: Icon }) => { const badge = id === 'jobs' ? props.jobs.filter((job) => job.status === 'waiting-for-user').length : id === 'agents' ? props.mcp.sessions.length : 0; return <button key={id} className={props.tab === id ? 'active' : ''} onClick={() => props.onTab(id)}><Icon size={15} />{label}{badge > 0 && <em>{badge}</em>}</button>; })}</nav><div className="right-content">{props.tab === 'inspector' && <Inspector {...props} />}{props.tab === 'structure' && <StructurePanel {...props} />}{props.tab === 'activity' && <ActivityPanel {...props} />}{props.tab === 'jobs' && <JobPanel {...props} />}{props.tab === 'agents' && <AgentsPanel {...props} />}</div></aside>;
}
