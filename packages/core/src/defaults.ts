import { createId, nowIso } from './ids';
import { declaredProjectRootError } from './declared-values';
import { HUMAN_ACTOR, type AIMuseProject, type Actor, type EntityBase, type ProjectKind, type Track, type TrackKind } from './model';

export function entityBase(prefix: string, actor: Actor = HUMAN_ACTOR): EntityBase {
  const timestamp = nowIso();
  return { id: createId(prefix), revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actor.id, updatedBy: actor.id };
}

export function createTrack(kind: TrackKind, name: string, color: string, actor: Actor = HUMAN_ACTOR): Track {
  return {
    ...entityBase('track', actor), kind, name, color,
    clipIds: [], deviceIds: [], automationLaneIds: [], childTrackIds: [],
    gainDb: 0, pan: 0, mute: false, solo: false, armed: false, frozen: false, collapsed: false,
    routing: { monitor: 'auto' },
  };
}

export function createProject(kind: ProjectKind, name = kind === 'song' ? 'Untitled Song' : 'Untitled SFX', actor: Actor = HUMAN_ACTOR): AIMuseProject {
  const timestamp = nowIso();
  const master = createTrack('master', 'Master', '#f59e0b', actor);
  const first = kind === 'song'
    ? createTrack('instrument', 'Ideas', '#8b5cf6', actor)
    : createTrack('audio', 'SFX Layers', '#06b6d4', actor);
  first.routing.outputTrackId = master.id;
  const tempo = { ...entityBase('tempo', actor), tick: 0, bpm: kind === 'song' ? 120 : 100, curve: 'step' as const };
  const signature = { ...entityBase('meter', actor), tick: 0, numerator: 4, denominator: 4 as const };
  const project: AIMuseProject = {
    format: 'AIMuse', schemaVersion: 1, id: createId('project'), revision: 0, name, kind,
    createdAt: timestamp, updatedAt: timestamp, createdBy: structuredClone(actor), dirty: true,
    settings: { sampleRate: 48_000, channelLayout: 'stereo', ppq: 960, recordBitDepth: 24, countInBars: 1, metronomeEnabled: true, defaultCrossfadeTicks: 120, masterLufsTarget: kind === 'song' ? -14 : -16 },
    tempoEvents: { [tempo.id]: tempo }, tempoOrder: [tempo.id],
    timeSignatureEvents: { [signature.id]: signature }, timeSignatureOrder: [signature.id],
    markers: {}, markerOrder: [], sections: {}, sectionOrder: [], lyrics: '',
    tracks: { [first.id]: first, [master.id]: master }, trackOrder: [first.id, master.id], clips: {},
    takeLanes: {}, compSegments: {}, devices: {}, sends: {}, sidechains: {}, automationLanes: {},
    assets: {}, provenance: {}, sfxDeliverables: {}, checkpoints: {}, variants: {}, activity: [],
  };
  const rootError = declaredProjectRootError(project);
  if (rootError) throw new Error(rootError);
  return project;
}
