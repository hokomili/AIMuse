import { memo, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronRight, Circle, GripVertical, Headphones, LockKeyhole, MoreHorizontal } from 'lucide-react';
import type { AIMuseProject, Clip, MidiClip, ProjectTransaction, Track, TransportState } from '@aimuse/core';
import type { AgentPresence, TimelineSelection } from '../common/contracts';
import { barBeat, entity, timelineTickFromPointer, transaction } from './editor-helpers';

const TRACK_HEIGHT = 72;
const COLLAPSED_TRACK_HEIGHT = 38;
const PPQ = 960;
type TimelineTool = 'select' | 'split' | 'draw';

interface TimelineProps {
  project: AIMuseProject;
  transport: TransportState;
  selection?: TimelineSelection;
  agents: AgentPresence[];
  pixelsPerBar: number;
  onPixelsPerBar(value: number): void;
  onSelection(selection?: TimelineSelection): void;
  onApply: (edit: ProjectTransaction) => Promise<boolean>;
  onTrackToggle(track: Track, field: 'mute' | 'solo' | 'armed'): void;
  onTrackCollapse(track: Track): void;
  onCreateMidiClip(trackId: string, startTick: number): void;
  onOpenInspector(): void;
  notify(message: string): void;
}

interface DragState {
  clipId: string;
  originX: number;
  originTick: number;
  previewTick: number;
  lockId?: string;
}

function seededBars(seed: string, count = 54): number[] {
  let state = [...seed].reduce((sum, character) => (sum * 33 + character.charCodeAt(0)) >>> 0, 7);
  return Array.from({ length: count }, () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return 0.18 + (state / 0xffffffff) * 0.76;
  });
}

function Waveform({ seed }: { seed: string }) {
  const bars = useMemo(() => seededBars(seed), [seed]);
  return <div className="clip-waveform" aria-hidden="true">{bars.map((height, index) => <i key={index} style={{ height: `${height * 100}%` }} />)}</div>;
}

function MidiPreview({ clip }: { clip: MidiClip }) {
  const notes = clip.noteOrder.map((noteId) => clip.notes[noteId]).filter(Boolean);
  if (!notes.length) return <div className="empty-midi-preview"><i /><i /><i /><i /></div>;
  return <div className="midi-preview" aria-hidden="true">{notes.slice(0, 80).map((note) => (
    <i key={note.id} style={{ left: `${(note.startTick / Math.max(1, clip.durationTicks)) * 100}%`, width: `${Math.max(1.4, note.durationTicks / clip.durationTicks * 100)}%`, bottom: `${((note.pitch - 36) / 60) * 85}%` }} />
  ))}</div>;
}

const TrackHeader = memo(function TrackHeader({ track, selected, locked, onSelect, onToggle, onCollapse }: {
  track: Track; selected: boolean; locked: boolean; onSelect(): void; onToggle(field: 'mute' | 'solo' | 'armed'): void; onCollapse(): void;
}) {
  return <div className={`track-header ${selected ? 'selected' : ''} ${track.kind === 'master' ? 'master-track' : ''} ${track.collapsed ? 'collapsed' : ''}`} onClick={onSelect}>
    <button className="track-fold" onClick={(event) => { event.stopPropagation(); onCollapse(); }} aria-label={track.collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}>{track.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
    <span className="track-color" style={{ background: track.color }} />
    <div className="track-identity">
      <strong>{track.name}</strong>
      <span>{track.kind === 'midi' ? 'MIDI out' : track.kind}</span>
    </div>
    <div className="track-actions">
      <button className={track.mute ? 'active mute' : ''} onClick={(event) => { event.stopPropagation(); onToggle('mute'); }} aria-label={`Mute ${track.name}`}>M</button>
      <button className={track.solo ? 'active solo' : ''} onClick={(event) => { event.stopPropagation(); onToggle('solo'); }} aria-label={`Solo ${track.name}`}>S</button>
      {track.kind !== 'master' && <button className={track.armed ? 'active armed' : ''} onClick={(event) => { event.stopPropagation(); onToggle('armed'); }} aria-label={`Arm ${track.name}`}><Circle size={8} fill="currentColor" /></button>}
    </div>
    <div className="track-monitor"><Headphones size={12} /><span>{track.routing.monitor}</span></div>
    {locked && <LockKeyhole className="entity-lock" size={12} aria-label="Locked by a collaborator" />}
  </div>;
});

export function Timeline({ project, transport, selection, agents, pixelsPerBar, onPixelsPerBar, onSelection, onApply, onTrackToggle, onTrackCollapse, onCreateMidiClip, onOpenInspector, notify }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<TimelineTool>('select');
  const [drag, setDrag] = useState<DragState>();
  const [scrubTick, setScrubTick] = useState<number>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const scrubPointerRef = useRef<number | undefined>(undefined);
  const pendingSeekRef = useRef<number | undefined>(undefined);
  const seekRunningRef = useRef(false);
  const ticksPerPixel = 4 * PPQ / pixelsPerBar;
  const clips = Object.values(project.clips);
  const lastTick = Math.max(16 * 4 * PPQ, ...clips.map((clip) => clip.startTick + clip.durationTicks), ...Object.values(project.sections).map((section) => section.endTick));
  const bars = Math.ceil(lastTick / (4 * PPQ)) + 4;
  const contentWidth = bars * pixelsPerBar;
  const displayTick = scrubTick ?? transport.tick;
  const selectedTrackId = selection?.trackIds[0];
  const lockedEntities = new Set<string>();
  const trackLayout = project.trackOrder.map((trackId, index, order) => ({
    trackId,
    top: order.slice(0, index).reduce((sum, id) => sum + (project.tracks[id].collapsed ? COLLAPSED_TRACK_HEIGHT : TRACK_HEIGHT), 0),
    height: project.tracks[trackId].collapsed ? COLLAPSED_TRACK_HEIGHT : TRACK_HEIGHT,
  }));
  const totalTrackHeight = trackLayout.reduce((sum, entry) => sum + entry.height, 0);

  const selectTrack = (trackId: string) => {
    const next = { trackIds: [trackId], clipIds: [] };
    onSelection(next);
    void window.aimuse.updateSelection(next).catch((cause) => notify(cause instanceof Error ? cause.message : String(cause)));
  };

  const selectClip = (clip: Clip) => {
    const next = { trackIds: [clip.trackId], clipIds: [clip.id], startTick: clip.startTick, endTick: clip.startTick + clip.durationTicks };
    onSelection(next);
    void window.aimuse.updateSelection(next).catch((cause) => notify(cause instanceof Error ? cause.message : String(cause)));
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectClip(clip);
    event.currentTarget.setPointerCapture(event.pointerId);
    const state: DragState = { clipId: clip.id, originX: event.clientX, originTick: clip.startTick, previewTick: clip.startTick };
    dragRef.current = state;
    setDrag(state);
    void window.aimuse.acquireHumanLock({ projectId: project.id, entityIds: [clip.id], range: { trackId: clip.trackId, startTick: clip.startTick, endTick: clip.startTick + clip.durationTicks } }).then((result) => {
      if (dragRef.current?.clipId === clip.id && result.acquired) {
        dragRef.current = { ...dragRef.current, lockId: result.lockId };
        setDrag({ ...dragRef.current });
      }
    }).catch((cause) => notify(cause instanceof Error ? cause.message : String(cause)));
  };

  const splitClip = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (event.detail > 1) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const rawTick = clip.startTick + (event.clientX - rect.left) / Math.max(1, rect.width) * clip.durationTicks;
    const tick = Math.max(clip.startTick + 1, Math.min(clip.startTick + clip.durationTicks - 1, Math.round(rawTick / 120) * 120));
    const rightClip = { ...structuredClone(clip), ...entity('clip'), name: `${clip.name} (right)` } as Clip;
    void onApply(transaction(project, `Split “${clip.name}”`, [{ kind: 'clip.split', clipId: clip.id, tick, rightClip, expectedRevision: clip.revision }])).then((done) => {
      if (done) onSelection({ trackIds: [clip.trackId], clipIds: [rightClip.id], startTick: tick, endTick: clip.startTick + clip.durationTicks });
    });
  };

  const beginClipGesture = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (tool === 'split') { splitClip(event, clip); return; }
    if (tool === 'draw') { event.stopPropagation(); notify('Draw on an empty instrument lane to create a MIDI clip.'); return; }
    beginDrag(event, clip);
  };

  const createClipAtPointer = (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>, track: Track) => {
    if (track.kind !== 'instrument') { notify('MIDI clips can only be drawn on instrument tracks.'); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const tick = Math.max(0, Math.round(((event.clientX - rect.left) * ticksPerPixel) / 240) * 240);
    onCreateMidiClip(track.id, tick);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const rawTick = current.originTick + (event.clientX - current.originX) * ticksPerPixel;
    const previewTick = Math.max(0, Math.round(rawTick / 120) * 120);
    dragRef.current = { ...current, previewTick };
    setDrag({ ...dragRef.current });
  };

  const endDrag = async (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    const current = dragRef.current;
    if (!current || current.clipId !== clip.id) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    setDrag(undefined);
    try {
      if (current.previewTick !== clip.startTick) {
        await onApply(transaction(project, `Move “${clip.name}”`, [{ kind: 'clip.move', clipId: clip.id, trackId: clip.trackId, startTick: current.previewTick, expectedRevision: clip.revision }]));
      }
    } finally {
      if (current.lockId) await window.aimuse.releaseHumanLock(current.lockId).catch((cause) => notify(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const tickAtPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return timelineTickFromPointer(event.clientX, rect.left, ticksPerPixel);
  };

  const flushSeek = () => {
    if (seekRunningRef.current || pendingSeekRef.current === undefined) return;
    const tick = pendingSeekRef.current;
    pendingSeekRef.current = undefined;
    seekRunningRef.current = true;
    void window.aimuse.transport('seek', { tick }).catch((cause) => notify(cause instanceof Error ? cause.message : String(cause))).finally(() => {
      seekRunningRef.current = false;
      if (pendingSeekRef.current !== undefined) flushSeek();
      else if (scrubPointerRef.current === undefined) setScrubTick(undefined);
    });
  };

  const queueSeek = (tick: number) => {
    pendingSeekRef.current = tick;
    flushSeek();
  };

  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubPointerRef.current = event.pointerId;
    const tick = tickAtPointer(event);
    setScrubTick(tick);
    queueSeek(tick);
  };

  const moveScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const tick = tickAtPointer(event);
    setScrubTick(tick);
    queueSeek(tick);
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== event.pointerId) return;
    const tick = tickAtPointer(event);
    setScrubTick(tick);
    scrubPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    queueSeek(tick);
  };

  const cancelScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== event.pointerId) return;
    scrubPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!seekRunningRef.current && pendingSeekRef.current === undefined) setScrubTick(undefined);
  };

  return <section className="timeline-shell" aria-label="Arrangement timeline">
    <div className="timeline-toolbar">
      <div className="arrangement-title"><GripVertical size={14} /><strong>Arrangement</strong><span>{project.kind === 'song' ? 'Song' : 'SFX canvas'}</span></div>
      <div className="timeline-tools" role="toolbar" aria-label="Timeline tools">
        <button className={`tool ${tool === 'select' ? 'active' : ''}`} onClick={() => setTool('select')} aria-label="Select tool" aria-pressed={tool === 'select'}>↖</button><button className={`tool ${tool === 'split' ? 'active' : ''}`} onClick={() => setTool('split')} aria-label="Split tool" aria-pressed={tool === 'split'}>⌁</button><button className={`tool ${tool === 'draw' ? 'active' : ''}`} onClick={() => setTool('draw')} aria-label="Draw MIDI clip tool" aria-pressed={tool === 'draw'}>✎</button>
        <span className="snap-control">Snap <strong>1/16</strong></span>
        <label className="zoom-control">−<input type="range" min="48" max="220" value={pixelsPerBar} onChange={(event) => onPixelsPerBar(Number(event.target.value))} aria-label="Timeline zoom" />＋</label>
      </div>
    </div>
    <div className="timeline-grid" ref={scrollRef}>
      <div className="timeline-corner"><span>Tracks</span><button onClick={onOpenInspector} aria-label="Arrangement menu"><MoreHorizontal size={16} /></button></div>
      <div className={`ruler ${scrubTick === undefined ? '' : 'scrubbing'}`} style={{ width: contentWidth }} onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} aria-label="Timeline ruler. Click or drag to seek.">
        {Array.from({ length: bars }, (_, index) => <div className="ruler-bar" key={index} style={{ left: index * pixelsPerBar, width: pixelsPerBar }}><span>{index + 1}</span>{[1, 2, 3].map((beat) => <i key={beat} style={{ left: `${beat * 25}%` }} />)}</div>)}
        <div className="playhead-head" style={{ left: displayTick / (4 * PPQ) * pixelsPerBar }}><i /></div>
      </div>
      <div className="track-headers">
        {project.trackOrder.map((trackId) => {
          const track = project.tracks[trackId];
          const locked = agents.some((agent) => agent.range?.trackIds?.includes(track.id));
          return <TrackHeader key={track.id} track={track} selected={selectedTrackId === track.id} locked={locked || lockedEntities.has(track.id)} onSelect={() => selectTrack(track.id)} onToggle={(field) => onTrackToggle(track, field)} onCollapse={() => onTrackCollapse(track)} />;
        })}
      </div>
      <div className={`track-lanes tool-${tool}`} style={{ width: contentWidth, height: totalTrackHeight }}>
        {trackLayout.map(({ trackId, top, height }) => {
          const track = project.tracks[trackId];
          return <div className={`track-lane ${selectedTrackId === track.id ? 'selected' : ''} ${track.collapsed ? 'collapsed' : ''}`} key={track.id} style={{ top, height }} onPointerDown={(event) => { selectTrack(track.id); if (tool === 'draw' && event.target === event.currentTarget) createClipAtPointer(event, track); }} onDoubleClick={(event) => { if (tool === 'select' && event.target === event.currentTarget) createClipAtPointer(event, track); }}>
            {Array.from({ length: bars }, (_, index) => <i className="bar-grid" key={index} style={{ left: index * pixelsPerBar, width: pixelsPerBar }} />)}
            {!track.collapsed && track.clipIds.map((clipId) => {
              const clip = project.clips[clipId];
              if (!clip) return null;
              const previewTick = drag?.clipId === clip.id ? drag.previewTick : clip.startTick;
              const left = previewTick / (4 * PPQ) * pixelsPerBar;
              const width = Math.max(20, clip.durationTicks / (4 * PPQ) * pixelsPerBar);
              const selected = selection?.clipIds.includes(clip.id);
              return <div
                className={`arrangement-clip ${clip.kind} ${selected ? 'selected' : ''} ${clip.muted ? 'muted' : ''} ${drag?.clipId === clip.id ? 'dragging' : ''}`}
                key={clip.id} style={{ left, width, '--clip-color': clip.color } as React.CSSProperties}
                onPointerDown={(event) => beginClipGesture(event, clip)} onPointerMove={tool === 'select' ? moveDrag : undefined} onPointerUp={tool === 'select' ? (event) => void endDrag(event, clip) : undefined} onDoubleClick={tool === 'select' ? onOpenInspector : undefined}
                role="button" tabIndex={0} aria-label={`${clip.name}, ${clip.kind} clip at ${barBeat(clip.startTick)}`}
              >
                <div className="clip-title"><span>{clip.name}</span>{clip.loopEnabled && <span className="loop-badge">↻</span>}</div>
                {clip.kind === 'audio' ? <Waveform seed={clip.assetId + clip.id} /> : <MidiPreview clip={clip} />}
                {clip.fadeIn.durationTicks > 0 && <span className="fade-in" />}{clip.fadeOut.durationTicks > 0 && <span className="fade-out" />}
              </div>;
            })}
            {!track.collapsed && Object.values(project.automationLanes).filter((lane) => lane.trackId === track.id && lane.visible).map((lane) => <svg className="automation-preview" key={lane.id} viewBox={`0 0 ${contentWidth} ${height}`} preserveAspectRatio="none"><polyline points={lane.pointOrder.map((pointId) => { const point = lane.points[pointId]; return `${point.tick / (4 * PPQ) * pixelsPerBar},${height - point.value * height}`; }).join(' ')} /></svg>)}
          </div>;
        })}
        {agents.filter((agent) => agent.range).map((agent) => {
          const range = agent.range!;
          const selectedLayouts = range.trackIds?.length ? trackLayout.filter((entry) => range.trackIds!.includes(entry.trackId)) : trackLayout;
          const top = selectedLayouts.length ? Math.min(...selectedLayouts.map((entry) => entry.top)) : 0;
          const bottom = selectedLayouts.length ? Math.max(...selectedLayouts.map((entry) => entry.top + entry.height)) : totalTrackHeight;
          return <div className="agent-range" key={agent.actor.id} style={{ left: range.startTick / (4 * PPQ) * pixelsPerBar, width: Math.max(4, (range.endTick - range.startTick) / (4 * PPQ) * pixelsPerBar), top, height: Math.max(1, bottom - top), '--actor-color': agent.actor.color } as React.CSSProperties}><span>{agent.actor.name}</span></div>;
        })}
        <div className="playhead-line" style={{ left: displayTick / (4 * PPQ) * pixelsPerBar, height: totalTrackHeight }} />
      </div>
    </div>
    <div className="timeline-status"><span>{project.trackOrder.length} tracks</span><span>{Object.keys(project.clips).length} clips</span><span>{project.settings.sampleRate / 1_000} kHz · 32-bit float</span><span className="timeline-position">{barBeat(displayTick)}</span></div>
  </section>;
}
