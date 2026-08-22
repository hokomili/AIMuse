import type {
  Actor,
  AIMuseProject,
  AutomationLane,
  BuiltinDeviceKind,
  Device,
  DeviceParameter,
  EntityBase,
  MidiClip,
  MidiNote,
  ProjectOperation,
  ProjectTransaction,
  Track,
  TrackKind,
} from '@aimuse/core';

export const HUMAN: Actor = { id: 'human-local', kind: 'human', name: 'You', color: '#a78bfa' };
export const TRACK_COLORS = ['#8b5cf6', '#18b6a4', '#ef6f91', '#f59e0b', '#4f8cff', '#c084fc', '#66c27c'];

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function entity(prefix: string): EntityBase {
  const timestamp = new Date().toISOString();
  return { id: id(prefix), revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN.id, updatedBy: HUMAN.id };
}

export function transaction(project: AIMuseProject, label: string, operations: ProjectOperation[], checkpointPolicy: ProjectTransaction['checkpointPolicy'] = 'none'): ProjectTransaction {
  return {
    id: id('tx'),
    clientOperationId: id('gesture'),
    projectId: project.id,
    actor: HUMAN,
    label,
    createdAt: new Date().toISOString(),
    operations,
    checkpointPolicy,
  };
}

export function makeTrack(project: AIMuseProject, kind: TrackKind, name?: string): Track {
  const master = Object.values(project.tracks).find((track) => track.kind === 'master');
  const names: Record<TrackKind, string> = { audio: 'Audio', instrument: 'Instrument', midi: 'External MIDI', folder: 'Group', aux: 'Return', master: 'Master' };
  return {
    ...entity('track'), kind, name: name ?? names[kind],
    color: TRACK_COLORS[project.trackOrder.length % TRACK_COLORS.length],
    clipIds: [], deviceIds: [], automationLaneIds: [], childTrackIds: [],
    gainDb: 0, pan: 0, mute: false, solo: false, armed: false, frozen: false, collapsed: false,
    routing: { outputTrackId: kind === 'master' ? undefined : master?.id, monitor: 'auto' },
  };
}

export function makeMidiClip(trackId: string, startTick: number, name = 'New idea'): MidiClip {
  const length = 4 * 4 * 960;
  return {
    ...entity('clip'), kind: 'midi', trackId, name, color: '#8b5cf6', startTick, durationTicks: length,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' },
    loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

export function makeNote(startTick: number, pitch: number, durationTicks = 480, velocity = 0.8): MidiNote {
  return {
    ...entity('note'), startTick, durationTicks, pitch: Math.max(0, Math.min(127, pitch)),
    velocity, releaseVelocity: 0.5, channel: 1, probability: 1,
  };
}

export function makeTrackVolumeAutomation(project: AIMuseProject, trackId: string): AutomationLane {
  const track = project.tracks[trackId];
  const normalizedGain = track ? Math.max(0, Math.min(1, (track.gainDb + 60) / 72)) : 5 / 6;
  const point = { ...entity('automation-point'), tick: 0, value: normalizedGain, curve: 'linear' as const };
  return {
    ...entity('automation-lane'),
    trackId,
    target: { kind: 'track', parameter: 'gainDb' },
    points: { [point.id]: point },
    pointOrder: [point.id],
    armed: false,
    visible: true,
  };
}

function expectedRevision(project: AIMuseProject, operation: ProjectOperation): number | undefined {
  switch (operation.kind) {
    case 'tempo.upsert': return project.tempoEvents[operation.event.id]?.revision;
    case 'tempo.delete': return project.tempoEvents[operation.eventId]?.revision;
    case 'meter.upsert': return project.timeSignatureEvents[operation.event.id]?.revision;
    case 'meter.delete': return project.timeSignatureEvents[operation.eventId]?.revision;
    case 'marker.update': case 'marker.delete': return project.markers[operation.markerId]?.revision;
    case 'section.update': case 'section.delete': return project.sections[operation.sectionId]?.revision;
    case 'track.update': case 'track.move': case 'track.delete': return project.tracks[operation.trackId]?.revision;
    case 'clip.update': case 'clip.move': case 'clip.trim': case 'clip.split': case 'clip.delete': return project.clips[operation.clipId]?.revision;
    case 'take-lane.update': case 'take-lane.delete': return project.takeLanes[operation.laneId]?.revision;
    case 'comp-segment.upsert': return project.compSegments[operation.segment.id]?.revision;
    case 'comp-segment.delete': return project.compSegments[operation.segmentId]?.revision;
    case 'midi.note.add': case 'midi.note.update': case 'midi.note.delete':
    case 'midi.control.add': case 'midi.control.delete':
    case 'midi.pitch-bend.add': case 'midi.pitch-bend.update': case 'midi.pitch-bend.delete':
    case 'midi.semantic': return project.clips[operation.clipId]?.revision;
    case 'automation.lane.update': case 'automation.lane.delete':
    case 'automation.point.upsert': case 'automation.point.delete': return project.automationLanes[operation.laneId]?.revision;
    case 'device.update': case 'device.move': case 'device.parameter.set': case 'device.delete': return project.devices[operation.deviceId]?.revision;
    case 'send.upsert': return project.sends[operation.send.id]?.revision;
    case 'send.delete': return project.sends[operation.sendId]?.revision;
    case 'sidechain.upsert': return project.sidechains[operation.route.id]?.revision;
    case 'sidechain.delete': return project.sidechains[operation.routeId]?.revision;
    case 'asset.delete': return project.assets[operation.assetId]?.revision;
    case 'sfx-deliverable.update': case 'sfx-deliverable.delete': return project.sfxDeliverables[operation.deliverableId]?.revision;
    case 'checkpoint.delete': return project.checkpoints[operation.checkpointId]?.revision;
    case 'variant.update': return project.variants[operation.variantId]?.revision;
    default: return undefined;
  }
}

/**
 * UI gestures are created from the last rendered snapshot, but multiple local
 * gestures can be waiting behind one another while agents also commit. Rebase
 * only the optimistic entity revision guards onto a freshly observed project;
 * the actual operation payload and idempotency identity remain unchanged.
 */
export function rebaseUiTransaction(edit: ProjectTransaction, project: AIMuseProject): ProjectTransaction {
  if (edit.projectId !== project.id) return edit;
  return {
    ...edit,
    operations: edit.operations.map((operation) => {
      if (!('expectedRevision' in operation) || operation.expectedRevision === undefined) return operation;
      const revision = expectedRevision(project, operation);
      return revision === undefined ? operation : { ...operation, expectedRevision: revision } as ProjectOperation;
    }),
  };
}

const parameter = (id: string, name: string, value: number, min: number, max: number, unit?: string): DeviceParameter => ({
  id, name, value, defaultValue: value, min, max, unit, automatable: true,
});

const builtinParameters: Record<BuiltinDeviceKind, DeviceParameter[]> = {
  sampler: [parameter('gain', 'Gain', 0, -48, 12, 'dB'), parameter('attack', 'Attack', 0.005, 0, 5, 's'), parameter('release', 'Release', 0.2, 0, 10, 's')],
  'drum-rack': [parameter('gain', 'Gain', 0, -48, 12, 'dB'), parameter('choke', 'Choke', 0, 0, 1)],
  'subtractive-synth': [parameter('cutoff', 'Cutoff', 8_000, 20, 20_000, 'Hz'), parameter('resonance', 'Resonance', 0.15, 0, 1), parameter('attack', 'Attack', 0.01, 0, 5, 's'), parameter('release', 'Release', 0.4, 0, 10, 's')],
  utility: [parameter('gain', 'Gain', 0, -48, 24, 'dB'), parameter('width', 'Width', 1, 0, 2)],
  eq: [parameter('lowGain', 'Low', 0, -18, 18, 'dB'), parameter('midGain', 'Mid', 0, -18, 18, 'dB'), parameter('highGain', 'High', 0, -18, 18, 'dB')],
  compressor: [parameter('threshold', 'Threshold', -18, -60, 0, 'dB'), parameter('ratio', 'Ratio', 4, 1, 20), parameter('attack', 'Attack', 0.01, 0.0001, 1, 's'), parameter('release', 'Release', 0.12, 0.01, 3, 's')],
  gate: [parameter('threshold', 'Threshold', -42, -80, 0, 'dB'), parameter('release', 'Release', 0.1, 0.001, 2, 's')],
  saturator: [parameter('drive', 'Drive', 3, 0, 36, 'dB'), parameter('mix', 'Mix', 1, 0, 1)],
  chorus: [parameter('rate', 'Rate', 0.8, 0.01, 10, 'Hz'), parameter('depth', 'Depth', 0.35, 0, 1), parameter('mix', 'Mix', 0.3, 0, 1)],
  delay: [parameter('time', 'Time', 0.25, 0.001, 2, 's'), parameter('feedback', 'Feedback', 0.35, 0, 0.98), parameter('mix', 'Mix', 0.25, 0, 1)],
  reverb: [parameter('size', 'Size', 0.55, 0, 1), parameter('decay', 'Decay', 2.2, 0.1, 20, 's'), parameter('mix', 'Mix', 0.22, 0, 1)],
  limiter: [parameter('ceiling', 'Ceiling', -1, -12, 0, 'dB'), parameter('release', 'Release', 0.08, 0.001, 1, 's')],
  analyzer: [],
};

export function makeBuiltinDevice(trackId: string, kind: BuiltinDeviceKind): Device {
  const labels: Record<BuiltinDeviceKind, string> = {
    sampler: 'Sampler', 'drum-rack': 'Drum Rack', 'subtractive-synth': 'Muse Synth', utility: 'Utility', eq: 'Parametric EQ',
    compressor: 'Compressor', gate: 'Gate', saturator: 'Saturator', chorus: 'Chorus', delay: 'Delay', reverb: 'Algorithmic Reverb', limiter: 'Limiter', analyzer: 'Spectrum & Loudness',
  };
  const parameters = Object.fromEntries(builtinParameters[kind].map((entry) => [entry.id, { ...entry }]));
  return { ...entity('device'), trackId, format: 'builtin', builtinKind: kind, name: labels[kind], bypassed: false, degraded: false, latencySamples: 0, parameters };
}

export function barBeat(tick: number, ppq = 960): string {
  const beat = Math.max(0, tick) / ppq;
  return `${Math.floor(beat / 4) + 1}.${Math.floor(beat % 4) + 1}.${Math.floor((beat % 1) * ppq)}`;
}

export function formatTime(tick: number, bpm: number, ppq = 960): string {
  const seconds = Math.max(0, tick) / ppq * 60 / bpm;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function timelineTickFromPointer(clientX: number, rulerLeft: number, ticksPerPixel: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(rulerLeft) || !Number.isFinite(ticksPerPixel) || ticksPerPixel <= 0) return 0;
  return Math.max(0, Math.round((clientX - rulerLeft) * ticksPerPixel));
}

export function db(value: number): string {
  return value <= -90 ? '-∞' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}
