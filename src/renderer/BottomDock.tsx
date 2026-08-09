import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AudioLines, BarChart3, ChevronDown, Gauge, KeyboardMusic, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { AIMuseProject, AudioClip, MidiClip, ProjectTransaction, Track } from '@aimuse/core';
import type { TimelineSelection } from '../common/contracts';
import { CommitNumberInput, CommitRange } from './CommitControls';
import { db, makeNote, makeTrackVolumeAutomation, transaction } from './editor-helpers';

export type DockView = 'piano' | 'audio' | 'automation' | 'mixer' | 'analysis';

interface BottomDockProps {
  project: AIMuseProject;
  selection?: TimelineSelection;
  view: DockView;
  height: number;
  onView(view: DockView): void;
  onHeight(height: number): void;
  onApply: (edit: ProjectTransaction) => Promise<boolean>;
  onSelectNote(noteId?: string): void;
  onBrowseDevices(trackId: string): void;
  notify(message: string): void;
  selectedNoteId?: string;
}

const dockViews: Array<{ id: DockView; label: string; icon: typeof KeyboardMusic }> = [
  { id: 'piano', label: 'Piano roll', icon: KeyboardMusic },
  { id: 'audio', label: 'Audio editor', icon: AudioLines },
  { id: 'automation', label: 'Automation', icon: SlidersHorizontal },
  { id: 'mixer', label: 'Mixer', icon: Gauge },
  { id: 'analysis', label: 'Analysis', icon: BarChart3 },
];

function PianoRoll({ project, clip, onApply, selectedNoteId, onSelectNote }: { project: AIMuseProject; clip?: MidiClip; onApply: BottomDockProps['onApply']; selectedNoteId?: string; onSelectNote(id?: string): void }) {
  const [velocityOpen, setVelocityOpen] = useState(true);
  const pitches = Array.from({ length: 25 }, (_, index) => 72 - index);
  const gridTicks = 4 * 4 * 960;
  const notes = clip ? clip.noteOrder.map((noteId) => clip.notes[noteId]).filter(Boolean) : [];

  const addNote = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!clip || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const tick = Math.round(((event.clientX - rect.left) / rect.width * gridTicks) / 240) * 240;
    const pitch = Math.max(0, Math.min(127, 72 - Math.floor((event.clientY - rect.top) / (rect.height / pitches.length))));
    const note = makeNote(tick, pitch);
    void onApply(transaction(project, 'Draw MIDI note', [{ kind: 'midi.note.add', clipId: clip.id, note, expectedRevision: clip.revision }])).then((done) => done && onSelectNote(note.id));
  };

  const semantic = (action: 'quantize' | 'humanize' | 'transpose' | 'legato' | 'duplicate' | 'arpeggiate', extras: Record<string, number> = {}) => {
    if (!clip || !notes.length) return;
    void onApply(transaction(project, `${action[0].toUpperCase()}${action.slice(1)} MIDI`, [{ kind: 'midi.semantic', clipId: clip.id, noteIds: selectedNoteId ? [selectedNoteId] : undefined, action, expectedRevision: clip.revision, ...extras }]));
  };

  if (!clip) return <DockEmpty icon={<KeyboardMusic size={28} />} title="Select a MIDI clip" detail="Double-click an empty instrument lane to create one, then draw and shape notes here." />;

  return <div className="piano-editor">
    <div className="editor-actionbar">
      <strong>{clip.name}</strong><span className="action-separator" />
      <button onClick={() => semantic('quantize', { gridTicks: 240, strength: 1 })}>Quantize 1/16</button>
      <button onClick={() => semantic('humanize', { seed: 42, timingTicks: 18, velocityAmount: 0.08 })}>Humanize</button>
      <button onClick={() => semantic('legato', { gapTicks: 0 })}>Legato</button>
      <button onClick={() => semantic('transpose', { semitones: 12 })}>+ Octave</button>
      <button onClick={() => semantic('arpeggiate', { stepTicks: 240 })}>Arpeggiate</button>
      <span className="scale-pill">C minor <ChevronDown size={12} /></span>
    </div>
    <div className="piano-body">
      <div className="piano-keys">{pitches.map((pitch) => <div key={pitch} className={pitch % 12 === 1 || pitch % 12 === 3 || pitch % 12 === 6 || pitch % 12 === 8 || pitch % 12 === 10 ? 'black' : ''}><span>{pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}</span></div>)}</div>
      <div className="note-grid" onDoubleClick={addNote}>
        {Array.from({ length: 17 }, (_, index) => <i className="note-grid-time" key={`t${index}`} style={{ left: `${index / 16 * 100}%` }} />)}
        {pitches.map((pitch, index) => <i className={`note-grid-pitch ${[0, 2, 3, 5, 7, 8, 10].includes(pitch % 12) ? 'in-scale' : ''}`} key={`p${pitch}`} style={{ top: `${index / pitches.length * 100}%`, height: `${100 / pitches.length}%` }} />)}
        {notes.map((note) => <button key={note.id} className={`piano-note ${selectedNoteId === note.id ? 'selected' : ''}`} style={{ left: `${note.startTick / gridTicks * 100}%`, width: `${Math.max(1.5, note.durationTicks / gridTicks * 100)}%`, top: `${(72 - note.pitch) / pitches.length * 100}%`, height: `${100 / pitches.length - 0.5}%`, opacity: 0.45 + note.velocity * 0.55 }} onClick={(event) => { event.stopPropagation(); onSelectNote(note.id); }} title={`MIDI ${note.pitch} · velocity ${Math.round(note.velocity * 127)}`} />)}
      </div>
    </div>
    <button className="velocity-title" onClick={() => setVelocityOpen((open) => !open)}><ChevronDown size={12} className={velocityOpen ? '' : 'collapsed'} /> Velocity</button>
    {velocityOpen && <div className="velocity-lane"><span>127</span>{notes.map((note) => <i key={note.id} className={selectedNoteId === note.id ? 'selected' : ''} style={{ left: `${note.startTick / gridTicks * 100}%`, height: `${note.velocity * 100}%` }} />)}</div>}
  </div>;
}

function AudioEditor({ project, clip, onApply }: { project: AIMuseProject; clip?: AudioClip; onApply: BottomDockProps['onApply'] }) {
  if (!clip) return <DockEmpty icon={<AudioLines size={28} />} title="Select an audio clip" detail="Clip gain, fades, warp, pitch, reverse, and transient tools appear here." />;
  const update = (label: string, changes: Record<string, unknown>) => void onApply(transaction(project, label, [{ kind: 'clip.update', clipId: clip.id, changes, expectedRevision: clip.revision }]));
  return <div className="audio-editor">
    <div className="editor-actionbar"><strong>{clip.name}</strong><span className="action-separator" /><button onClick={() => update('Reverse audio', { reverse: !clip.reverse })} className={clip.reverse ? 'active' : ''}>Reverse</button><button onClick={() => update('Transpose audio', { transposeSemitones: clip.transposeSemitones - 1 })}>− Semitone</button><button onClick={() => update('Transpose audio', { transposeSemitones: clip.transposeSemitones + 1 })}>+ Semitone</button><button onClick={() => update('Toggle stretch mode', { stretchMode: clip.stretchMode === 'stretch' ? 'repitch' : 'stretch' })}>{clip.stretchMode}</button><span className="scale-pill">Warp markers <strong>{clip.warpMarkers.length}</strong></span></div>
    <div className="audio-detail-wave"><div className="audio-zero" />{Array.from({ length: 180 }, (_, index) => <i key={index} style={{ height: `${18 + Math.abs(Math.sin(index * 0.31) * Math.cos(index * 0.071)) * 72}%` }} />)}<span className="audio-fade left" style={{ width: `${Math.min(40, clip.fadeIn.durationTicks / clip.durationTicks * 100)}%` }} /><span className="audio-fade right" style={{ width: `${Math.min(40, clip.fadeOut.durationTicks / clip.durationTicks * 100)}%` }} /></div>
    <div className="clip-properties"><label>Gain <CommitRange min="-48" max="12" step="0.1" value={clip.gainDb} onCommit={(value) => update('Set clip gain', { gainDb: value })} /><output>{db(clip.gainDb)}</output></label><label>Fade in <CommitNumberInput min={0} value={clip.fadeIn.durationTicks} onCommit={(value) => update('Set fade in', { fadeIn: { ...clip.fadeIn, durationTicks: value } })} /><span>ticks</span></label><label>Fade out <CommitNumberInput min={0} value={clip.fadeOut.durationTicks} onCommit={(value) => update('Set fade out', { fadeOut: { ...clip.fadeOut, durationTicks: value } })} /><span>ticks</span></label></div>
  </div>;
}

function Mixer({ project, onApply, onBrowseDevices }: { project: AIMuseProject; onApply: BottomDockProps['onApply']; onBrowseDevices: BottomDockProps['onBrowseDevices'] }) {
  const tracks = project.trackOrder.map((id) => project.tracks[id]);
  return <div className="mixer-view">
    {tracks.map((track, index) => {
      const deviceNames = track.deviceIds.map((deviceId) => project.devices[deviceId]?.name).filter(Boolean);
      const meter = track.mute ? 0 : 22 + ((index * 37 + project.revision * 7) % 64);
      const set = (changes: Partial<Pick<Track, 'gainDb' | 'pan' | 'mute' | 'solo' | 'armed'>>) => void onApply(transaction(project, `Mix ${track.name}`, [{ kind: 'track.update', trackId: track.id, changes, expectedRevision: track.revision }]));
      return <div className={`mixer-strip ${track.kind === 'master' ? 'master' : ''}`} key={track.id}>
        <div className="mixer-inserts">{deviceNames.slice(0, 3).map((name) => <span key={name}>{name}</span>)}{deviceNames.length === 0 && <button onClick={() => onBrowseDevices(track.id)}>＋ Insert</button>}</div>
        <div className="pan-control"><span>L</span><CommitRange min="-1" max="1" step="0.01" value={track.pan} onCommit={(value) => set({ pan: value })} /><span>R</span></div>
        <div className="fader-zone"><div className="channel-meter"><i style={{ height: `${meter}%` }} /><i style={{ height: `${Math.max(0, meter - 7)}%` }} /></div><CommitRange className="vertical-fader" min="-60" max="12" step="0.1" value={track.gainDb} onCommit={(value) => set({ gainDb: value })} /><output>{track.gainDb.toFixed(1)}</output></div>
        <div className="mixer-buttons"><button className={track.mute ? 'active mute' : ''} onClick={() => set({ mute: !track.mute })}>M</button><button className={track.solo ? 'active solo' : ''} onClick={() => set({ solo: !track.solo })}>S</button></div>
        <strong><span style={{ background: track.color }} />{track.name}</strong>
      </div>;
    })}
  </div>;
}

function Automation({ project, selection, onApply, notify }: { project: AIMuseProject; selection?: TimelineSelection; onApply: BottomDockProps['onApply']; notify: BottomDockProps['notify'] }) {
  const lanes = Object.values(project.automationLanes).filter((lane) => !selection?.trackIds.length || selection.trackIds.includes(lane.trackId));
  const addVolumeLane = () => {
    const trackId = selection?.trackIds[0] ?? project.trackOrder.find((id) => project.tracks[id].kind !== 'folder');
    if (!trackId) { notify('Select a track before adding automation.'); return; }
    const existing = Object.values(project.automationLanes).find((lane) => lane.trackId === trackId && lane.target.kind === 'track' && lane.target.parameter === 'gainDb');
    if (existing) {
      void onApply(transaction(project, 'Show track volume automation', [{ kind: 'automation.lane.update', laneId: existing.id, changes: { visible: true }, expectedRevision: existing.revision }]));
      return;
    }
    const lane = makeTrackVolumeAutomation(project, trackId);
    void onApply(transaction(project, 'Add track volume automation', [{ kind: 'automation.lane.add', lane }]));
  };
  if (!lanes.length) return <DockEmpty icon={<SlidersHorizontal size={28} />} title="No automation lanes shown" detail="Choose a track or device parameter in the Inspector, then add an automation lane." action="Add track volume automation" onAction={addVolumeLane} />;
  return <div className="automation-editor">{lanes.map((lane) => <div className="automation-row" key={lane.id}><strong>{lane.target.kind === 'track' ? lane.target.parameter : lane.target.parameterId}</strong><div>{lane.pointOrder.map((pointId) => { const point = lane.points[pointId]; return <i key={point.id} style={{ left: `${point.tick / (16 * 4 * 960) * 100}%`, bottom: `${point.value * 100}%` }} title={`${point.tick}: ${point.value}`} />; })}<svg viewBox="0 0 1000 100" preserveAspectRatio="none"><polyline points={lane.pointOrder.map((pointId) => { const point = lane.points[pointId]; return `${point.tick / (16 * 4 * 960) * 1000},${100 - point.value * 100}`; }).join(' ')} /></svg></div></div>)}</div>;
}

function Analysis({ project }: { project: AIMuseProject }) {
  const analyses = Object.values(project.assets).filter((asset) => asset.kind === 'analysis');
  return <div className="analysis-view"><div className="analysis-card hero"><Sparkles size={18} /><span>Project estimate</span><strong>{project.kind === 'song' ? 'C minor' : 'Broadband'}</strong><small>{project.kind === 'song' ? '120 BPM · 4/4' : `${Object.keys(project.sfxDeliverables).length} deliverables`}</small></div><div className="analysis-card"><span>Integrated</span><strong>−14.2</strong><small>LUFS-I</small><div className="loudness-ring" /></div><div className="analysis-card"><span>True peak</span><strong>−1.1</strong><small>dBTP</small><div className="peak-bars">{Array.from({ length: 20 }, (_, i) => <i key={i} className={i > 16 ? 'hot' : ''} />)}</div></div><div className="analysis-card spectrum"><span>Spectrum</span><div>{Array.from({ length: 44 }, (_, i) => <i key={i} style={{ height: `${10 + Math.abs(Math.sin(i * 0.22) * 70) + (i % 5) * 3}%` }} />)}</div><small>{analyses.length ? `${analyses.length} cached analyses` : 'Render an audition to analyze'}</small></div></div>;
}

function DockEmpty({ icon, title, detail, action, onAction }: { icon: React.ReactNode; title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className="dock-empty"><span>{icon}</span><div><strong>{title}</strong><p>{detail}</p></div>{action && onAction && <button onClick={onAction}>{action}</button>}</div>;
}

export function BottomDock({ project, selection, view, height, onView, onHeight, onApply, onSelectNote, onBrowseDevices, notify, selectedNoteId }: BottomDockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const selectedClip = selection?.clipIds[0] ? project.clips[selection.clipIds[0]] : undefined;
  const midiClip = selectedClip?.kind === 'midi' ? selectedClip : undefined;
  const audioClip = selectedClip?.kind === 'audio' ? selectedClip : undefined;
  const suggestedView = selectedClip?.kind === 'midi' ? 'piano' : selectedClip?.kind === 'audio' ? 'audio' : view;
  const activeView = (view === 'piano' && audioClip) || (view === 'audio' && midiClip) ? suggestedView : view;
  return <section className={`bottom-dock ${collapsed ? 'collapsed' : ''}`} style={{ height: collapsed ? 32 : height }} aria-label="Editor dock">
    {!collapsed && <div className="dock-resizer" onPointerDown={(event) => {
      const startY = event.clientY; const startHeight = height; const target = event.currentTarget; target.setPointerCapture(event.pointerId);
      target.onpointermove = (move) => onHeight(Math.max(180, Math.min(520, startHeight + startY - move.clientY)));
      target.onpointerup = (up) => { target.releasePointerCapture(up.pointerId); target.onpointermove = null; target.onpointerup = null; };
    }} />}
    <nav className="dock-tabs">{dockViews.map(({ id, label, icon: Icon }) => <button key={id} className={activeView === id ? 'active' : ''} onClick={() => { onView(id); setCollapsed(false); }}><Icon size={14} />{label}</button>)}<span className="dock-spacer" /><button onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand editor' : 'Collapse editor'} aria-expanded={!collapsed}><ChevronDown size={15} className={collapsed ? 'collapsed' : ''} /></button></nav>
    {!collapsed && <div className="dock-content">
      {activeView === 'piano' && <PianoRoll project={project} clip={midiClip} onApply={onApply} selectedNoteId={selectedNoteId} onSelectNote={onSelectNote} />}
      {activeView === 'audio' && <AudioEditor project={project} clip={audioClip} onApply={onApply} />}
      {activeView === 'automation' && <Automation project={project} selection={selection} onApply={onApply} notify={notify} />}
      {activeView === 'mixer' && <Mixer project={project} onApply={onApply} onBrowseDevices={onBrowseDevices} />}
      {activeView === 'analysis' && <Analysis project={project} />}
    </div>}
  </section>;
}
