import type {
  Actor,
  AutomationLane,
  AutomationPoint,
  Checkpoint,
  Clip,
  CompSegment,
  Device,
  GenerationProvenance,
  Id,
  Marker,
  MediaAsset,
  MidiControlEvent,
  MidiNote,
  MidiPitchBendEvent,
  ProjectSettings,
  Send,
  SfxDeliverable,
  SidechainRoute,
  SongSection,
  TakeLane,
  TempoEvent,
  TimeSignatureEvent,
  Track,
  Variant,
} from './model';

export type ProjectOperation =
  | { kind: 'project.rename'; name: string }
  | { kind: 'project.settings.update'; changes: Partial<ProjectSettings> }
  | { kind: 'tempo.upsert'; event: TempoEvent; expectedRevision?: number }
  | { kind: 'tempo.delete'; eventId: Id; expectedRevision?: number }
  | { kind: 'meter.upsert'; event: TimeSignatureEvent; expectedRevision?: number }
  | { kind: 'meter.delete'; eventId: Id; expectedRevision?: number }
  | { kind: 'marker.add'; marker: Marker; index?: number }
  | { kind: 'marker.update'; markerId: Id; changes: Partial<Pick<Marker, 'tick' | 'endTick' | 'name' | 'color' | 'kind'>>; expectedRevision?: number }
  | { kind: 'marker.delete'; markerId: Id; expectedRevision?: number }
  | { kind: 'section.add'; section: SongSection; index?: number }
  | { kind: 'section.update'; sectionId: Id; changes: Partial<Pick<SongSection, 'name' | 'startTick' | 'endTick' | 'color' | 'energy' | 'prompt'>>; expectedRevision?: number }
  | { kind: 'section.delete'; sectionId: Id; expectedRevision?: number }
  | { kind: 'lyrics.set'; lyrics: string }
  | { kind: 'track.add'; track: Track; index?: number; parentId?: Id }
  | { kind: 'track.update'; trackId: Id; changes: Partial<Pick<Track, 'name' | 'color' | 'gainDb' | 'pan' | 'mute' | 'solo' | 'armed' | 'frozen' | 'collapsed' | 'routing'>>; expectedRevision?: number }
  | { kind: 'track.move'; trackId: Id; index: number; parentId?: Id; expectedRevision?: number }
  | { kind: 'track.delete'; trackId: Id; cascade: boolean; expectedRevision?: number }
  | { kind: 'clip.add'; clip: Clip; index?: number }
  | { kind: 'clip.update'; clipId: Id; changes: Partial<Omit<Clip, keyof { id: never } | 'id' | 'kind' | 'trackId' | 'createdAt' | 'createdBy' | 'revision' | 'updatedAt' | 'updatedBy'>>; expectedRevision?: number }
  | { kind: 'clip.move'; clipId: Id; trackId: Id; startTick: number; index?: number; expectedRevision?: number }
  | { kind: 'clip.trim'; clipId: Id; startTick: number; durationTicks: number; sourceStartSample?: number; sourceDurationSamples?: number; expectedRevision?: number }
  | { kind: 'clip.split'; clipId: Id; tick: number; rightClip: Clip; expectedRevision?: number }
  | { kind: 'clip.delete'; clipId: Id; expectedRevision?: number }
  | { kind: 'take-lane.add'; lane: TakeLane }
  | { kind: 'take-lane.update'; laneId: Id; changes: Partial<Pick<TakeLane, 'name' | 'active' | 'clipIds'>>; expectedRevision?: number }
  | { kind: 'take-lane.delete'; laneId: Id; expectedRevision?: number }
  | { kind: 'comp-segment.upsert'; segment: CompSegment; expectedRevision?: number }
  | { kind: 'comp-segment.delete'; segmentId: Id; expectedRevision?: number }
  | { kind: 'midi.note.add'; clipId: Id; note: MidiNote; expectedRevision?: number }
  | { kind: 'midi.note.update'; clipId: Id; noteId: Id; changes: Partial<Pick<MidiNote, 'startTick' | 'durationTicks' | 'pitch' | 'velocity' | 'releaseVelocity' | 'channel' | 'probability'>>; expectedRevision?: number }
  | { kind: 'midi.note.delete'; clipId: Id; noteId: Id; expectedRevision?: number }
  | { kind: 'midi.control.add'; clipId: Id; event: MidiControlEvent; expectedRevision?: number }
  | { kind: 'midi.control.delete'; clipId: Id; eventId: Id; expectedRevision?: number }
  | { kind: 'midi.pitch-bend.add'; clipId: Id; event: MidiPitchBendEvent; expectedRevision?: number }
  | { kind: 'midi.pitch-bend.update'; clipId: Id; eventId: Id; changes: Partial<Pick<MidiPitchBendEvent, 'tick' | 'value' | 'channel'>>; expectedRevision?: number }
  | { kind: 'midi.pitch-bend.delete'; clipId: Id; eventId: Id; expectedRevision?: number }
  | {
      kind: 'midi.semantic'; clipId: Id; noteIds?: Id[]; action: 'quantize' | 'humanize' | 'transpose' | 'legato' | 'duplicate' | 'arpeggiate';
      gridTicks?: number; strength?: number; seed?: number; timingTicks?: number; velocityAmount?: number; semitones?: number;
      gapTicks?: number; offsetTicks?: number; stepTicks?: number; expectedRevision?: number;
    }
  | { kind: 'automation.lane.add'; lane: AutomationLane }
  | { kind: 'automation.lane.update'; laneId: Id; changes: Partial<Pick<AutomationLane, 'armed' | 'visible' | 'target'>>; expectedRevision?: number }
  | { kind: 'automation.lane.delete'; laneId: Id; expectedRevision?: number }
  | { kind: 'automation.point.upsert'; laneId: Id; point: AutomationPoint; expectedRevision?: number }
  | { kind: 'automation.point.delete'; laneId: Id; pointId: Id; expectedRevision?: number }
  | { kind: 'device.add'; device: Device; index?: number }
  | { kind: 'device.update'; deviceId: Id; changes: Partial<Pick<Device, 'name' | 'bypassed' | 'degraded' | 'latencySamples' | 'stateAssetId' | 'presetName' | 'soundfont'>>; expectedRevision?: number }
  | { kind: 'device.move'; deviceId: Id; trackId: Id; index: number; expectedRevision?: number }
  | { kind: 'device.parameter.set'; deviceId: Id; parameterId: string; value: number; expectedRevision?: number }
  | { kind: 'device.delete'; deviceId: Id; expectedRevision?: number }
  | { kind: 'send.upsert'; send: Send; expectedRevision?: number }
  | { kind: 'send.delete'; sendId: Id; expectedRevision?: number }
  | { kind: 'sidechain.upsert'; route: SidechainRoute; expectedRevision?: number }
  | { kind: 'sidechain.delete'; routeId: Id; expectedRevision?: number }
  | { kind: 'asset.add'; asset: MediaAsset }
  | { kind: 'asset.delete'; assetId: Id; expectedRevision?: number }
  | { kind: 'provenance.register'; provenance: GenerationProvenance }
  | { kind: 'provenance.update'; provenanceId: Id; changes: Partial<Pick<GenerationProvenance, 'transformations' | 'modelVersion'>>; expectedRevision?: number }
  | { kind: 'sfx-deliverable.add'; deliverable: SfxDeliverable }
  | { kind: 'sfx-deliverable.update'; deliverableId: Id; changes: Partial<Omit<SfxDeliverable, 'id' | 'revision' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>>; expectedRevision?: number }
  | { kind: 'sfx-deliverable.delete'; deliverableId: Id; expectedRevision?: number }
  | { kind: 'checkpoint.register'; checkpoint: Checkpoint }
  | { kind: 'checkpoint.delete'; checkpointId: Id; expectedRevision?: number }
  | { kind: 'variant.register'; variant: Variant }
  | { kind: 'variant.update'; variantId: Id; changes: Partial<Pick<Variant, 'name' | 'status' | 'projectRevision' | 'snapshotAssetId'>>; expectedRevision?: number };

export interface ProjectTransaction {
  id: Id;
  clientOperationId: string;
  projectId: Id;
  actor: Actor;
  label: string;
  createdAt: string;
  operations: ProjectOperation[];
  checkpointPolicy?: 'none' | 'auto' | 'required';
}

export interface TransactionConflict {
  operationIndex: number;
  entityId?: Id;
  expectedRevision?: number;
  actualRevision?: number;
  message: string;
  retryable: boolean;
}

export class TransactionConflictError extends Error {
  constructor(public readonly conflict: TransactionConflict) {
    super(conflict.message);
    this.name = 'TransactionConflictError';
  }
}
