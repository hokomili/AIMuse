export type Id = string;
export type ActorKind = 'human' | 'agent' | 'system';

export interface ActorClientMetadata {
  product?: string;
  model?: string;
  effort?: string;
  taskId?: string;
  version?: string;
}

export interface Actor {
  id: Id;
  kind: ActorKind;
  name: string;
  color: string;
  client?: ActorClientMetadata;
}

export interface EntityBase {
  id: Id;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Id;
  updatedBy: Id;
}

export type ProjectKind = 'song' | 'sfx';
export type SampleRate = 44_100 | 48_000 | 96_000;
export type ChannelLayout = 'mono' | 'stereo';

export interface ProjectSettings {
  sampleRate: SampleRate;
  channelLayout: ChannelLayout;
  ppq: 960;
  recordBitDepth: 24 | 32;
  countInBars: number;
  metronomeEnabled: boolean;
  defaultCrossfadeTicks: number;
  masterLufsTarget: number;
}

export interface TempoEvent extends EntityBase {
  tick: number;
  bpm: number;
  curve: 'step' | 'linear';
}

export interface TimeSignatureEvent extends EntityBase {
  tick: number;
  numerator: number;
  denominator: 1 | 2 | 4 | 8 | 16 | 32;
}

export interface Marker extends EntityBase {
  tick: number;
  endTick?: number;
  name: string;
  color: string;
  kind: 'marker' | 'region' | 'cue';
}

export interface SongSection extends EntityBase {
  name: string;
  startTick: number;
  endTick: number;
  color: string;
  energy?: number;
  prompt?: string;
}

export type TrackKind = 'audio' | 'instrument' | 'midi' | 'folder' | 'aux' | 'master';

export interface TrackRouting {
  outputTrackId?: Id;
  inputDeviceId?: string;
  inputChannels?: number[];
  midiInputDeviceId?: string;
  midiOutputDeviceId?: string;
  monitor: 'off' | 'auto' | 'on';
}

export interface Track extends EntityBase {
  kind: TrackKind;
  name: string;
  color: string;
  parentId?: Id;
  clipIds: Id[];
  deviceIds: Id[];
  automationLaneIds: Id[];
  childTrackIds: Id[];
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  armed: boolean;
  frozen: boolean;
  collapsed: boolean;
  routing: TrackRouting;
}

export interface Fade {
  durationTicks: number;
  curve: 'linear' | 'equal-power' | 's-curve';
}

export interface WarpMarker extends EntityBase {
  sourceSample: number;
  projectTick: number;
}

export interface ClipBase extends EntityBase {
  trackId: Id;
  name: string;
  color: string;
  startTick: number;
  durationTicks: number;
  muted: boolean;
  gainDb: number;
  fadeIn: Fade;
  fadeOut: Fade;
  loopEnabled: boolean;
  loopLengthTicks?: number;
  takeLaneId?: Id;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  assetId: Id;
  sourceStartSample: number;
  sourceDurationSamples: number;
  transposeSemitones: number;
  stretchMode: 'repitch' | 'stretch';
  reverse: boolean;
  warpMarkers: WarpMarker[];
}

export interface MidiNote extends EntityBase {
  startTick: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
  releaseVelocity: number;
  channel: number;
  probability: number;
}

export interface MidiControlEvent extends EntityBase {
  tick: number;
  controller: number;
  value: number;
  channel: number;
}

export interface MidiPitchBendEvent extends EntityBase {
  tick: number;
  value: number;
  channel: number;
}

export interface MidiClip extends ClipBase {
  kind: 'midi';
  notes: Record<Id, MidiNote>;
  noteOrder: Id[];
  controls: Record<Id, MidiControlEvent>;
  controlOrder: Id[];
  pitchBends: Record<Id, MidiPitchBendEvent>;
  pitchBendOrder: Id[];
}

export type Clip = AudioClip | MidiClip;

export interface TakeLane extends EntityBase {
  trackId: Id;
  name: string;
  clipIds: Id[];
  active: boolean;
}

export interface CompSegment extends EntityBase {
  trackId: Id;
  takeLaneId: Id;
  startTick: number;
  endTick: number;
}

export type BuiltinDeviceKind =
  | 'sampler'
  | 'drum-rack'
  | 'subtractive-synth'
  | 'utility'
  | 'eq'
  | 'compressor'
  | 'gate'
  | 'saturator'
  | 'chorus'
  | 'delay'
  | 'reverb'
  | 'limiter'
  | 'analyzer';

export interface DeviceParameter {
  id: string;
  name: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  unit?: string;
  automatable: boolean;
}

export interface Device extends EntityBase {
  trackId: Id;
  format: 'builtin' | 'vst3' | 'clap' | 'missing';
  builtinKind?: BuiltinDeviceKind;
  pluginId?: string;
  pluginVersion?: string;
  pluginHash?: string;
  name: string;
  vendor?: string;
  bypassed: boolean;
  degraded: boolean;
  latencySamples: number;
  stateAssetId?: Id;
  presetName?: string;
  parameters: Record<string, DeviceParameter>;
}

export interface Send extends EntityBase {
  sourceTrackId: Id;
  destinationTrackId: Id;
  gainDb: number;
  preFader: boolean;
  enabled: boolean;
}

export interface SidechainRoute extends EntityBase {
  sourceTrackId: Id;
  destinationDeviceId: Id;
  busIndex: number;
  enabled: boolean;
}

export interface AutomationPoint extends EntityBase {
  tick: number;
  value: number;
  curve: 'hold' | 'linear' | 'bezier';
  tension?: number;
}

export interface AutomationLane extends EntityBase {
  trackId: Id;
  target: { kind: 'track'; parameter: 'gainDb' | 'pan' } | { kind: 'device'; deviceId: Id; parameterId: string };
  points: Record<Id, AutomationPoint>;
  pointOrder: Id[];
  armed: boolean;
  visible: boolean;
}

export type MediaKind = 'audio' | 'midi' | 'plugin-state' | 'analysis' | 'audition' | 'checkpoint';

export interface MediaAsset extends EntityBase {
  kind: MediaKind;
  name: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  storage: 'embedded' | 'linked' | 'managed-cache';
  relativePath?: string;
  externalPath?: string;
  sampleRate?: number;
  channels?: number;
  durationSamples?: number;
  source?: 'import' | 'recording' | 'generation' | 'render' | 'system';
}

export type GenerationProvider = 'elevenlabs' | 'stability' | 'lyria';
export type GenerationKind = 'music' | 'sfx' | 'audio-to-audio' | 'section-replace';

export interface GenerationProvenance extends EntityBase {
  assetId: Id;
  provider: GenerationProvider;
  model: string;
  modelVersion?: string;
  kind: GenerationKind;
  prompt: string;
  lyrics?: string;
  referenceAssetIds: Id[];
  requestId?: string;
  costMinor?: number;
  currency?: string;
  rightsDeclaration: 'original' | 'licensed' | 'owned-reference';
  transformations: string[];
  experimental: boolean;
}

export interface SfxDeliverable extends EntityBase {
  name: string;
  startTick: number;
  endTick: number;
  variantCount: number;
  tags: string[];
  seamlessLoop: boolean;
  loopStartSample?: number;
  loopEndSample?: number;
  tailMilliseconds: number;
  variation: {
    seed: number;
    pitchRangeSemitones: number;
    gainRangeDb: number;
    timingRangeMilliseconds: number;
  };
  targetLufs: number;
  namingTemplate: string;
  exportFormat: 'wav' | 'flac' | 'mp3';
}

export interface Checkpoint extends EntityBase {
  name: string;
  projectRevision: number;
  snapshotAssetId: Id;
  automatic: boolean;
  reason?: string;
}

export interface Variant extends EntityBase {
  name: string;
  baseCheckpointId: Id;
  snapshotAssetId?: Id;
  status: 'active' | 'merged' | 'discarded';
  projectRevision: number;
}

export interface ActivityEntry {
  id: Id;
  actor: Actor;
  transactionId?: Id;
  label: string;
  status: 'committed' | 'partial' | 'conflict' | 'failed' | 'undo' | 'redo' | 'checkpoint';
  createdAt: string;
  revision: number;
  details?: Record<string, unknown>;
}

export interface AIMuseProject {
  format: 'AIMuse';
  schemaVersion: 1;
  id: Id;
  revision: number;
  name: string;
  kind: ProjectKind;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  dirty: boolean;
  projectPath?: string;
  settings: ProjectSettings;
  tempoEvents: Record<Id, TempoEvent>;
  tempoOrder: Id[];
  timeSignatureEvents: Record<Id, TimeSignatureEvent>;
  timeSignatureOrder: Id[];
  markers: Record<Id, Marker>;
  markerOrder: Id[];
  sections: Record<Id, SongSection>;
  sectionOrder: Id[];
  lyrics: string;
  tracks: Record<Id, Track>;
  trackOrder: Id[];
  clips: Record<Id, Clip>;
  takeLanes: Record<Id, TakeLane>;
  compSegments: Record<Id, CompSegment>;
  devices: Record<Id, Device>;
  sends: Record<Id, Send>;
  sidechains: Record<Id, SidechainRoute>;
  automationLanes: Record<Id, AutomationLane>;
  assets: Record<Id, MediaAsset>;
  provenance: Record<Id, GenerationProvenance>;
  sfxDeliverables: Record<Id, SfxDeliverable>;
  checkpoints: Record<Id, Checkpoint>;
  variants: Record<Id, Variant>;
  activity: ActivityEntry[];
}

export type JobKind = 'approval' | 'generation' | 'analysis' | 'media' | 'plugin-scan' | 'plugin-host' | 'render' | 'save' | 'pack';
export type JobStatus = 'queued' | 'waiting-for-user' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  ambiguousCharge?: boolean;
}

export interface ApprovalRequest {
  kind: 'file-read' | 'file-write' | 'overwrite' | 'generation' | 'recording' | 'plugin' | 'unknown-cost';
  summary: string;
  request: Record<string, unknown>;
  expiresAt: string;
}

export interface AsyncJob<T = unknown> {
  id: Id;
  ownerActorId: Id;
  projectId?: Id;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  cancellable: boolean;
  approval?: ApprovalRequest;
  result?: T;
  error?: JobError;
}

export interface TransportState {
  status: 'stopped' | 'playing' | 'paused' | 'recording';
  projectId?: Id;
  tick: number;
  sample: number;
  loopEnabled: boolean;
  loopStartTick: number;
  loopEndTick: number;
  metronomeEnabled: boolean;
  cpuLoad: number;
  xruns: number;
  latencySamples: number;
  graphRevision: number;
}

export interface PluginDescriptor {
  id: string;
  format: 'vst3' | 'clap';
  name: string;
  vendor: string;
  version: string;
  path: string;
  sha256: string;
  categories: string[];
  instrument: boolean;
  quarantined: boolean;
  quarantineReason?: string;
  parameters: DeviceParameter[];
}

export const HUMAN_ACTOR: Actor = {
  id: 'human-local',
  kind: 'human',
  name: 'You',
  color: '#8b5cf6',
};
