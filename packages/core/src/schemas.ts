import { z } from 'zod';
import type { AIMuseProject } from './model';
import type { ProjectOperation, ProjectTransaction } from './operations';
import { validateProjectIntegrity } from './reducer';

const IdSchema = z.string().min(1).max(240);
const IsoSchema = z.string().datetime();
const FiniteSchema = z.number().refine(Number.isFinite, 'Expected a finite number');
const TickSchema = z.number().int().nonnegative();

const ActorSchema = z.object({
  id: IdSchema,
  kind: z.enum(['human', 'agent', 'system']),
  name: z.string().min(1).max(100),
  color: z.string().min(1).max(40),
  client: z.object({ product: z.string().max(100).optional(), model: z.string().max(160).optional(), effort: z.string().max(80).optional(), taskId: z.string().max(240).optional(), version: z.string().max(80).optional() }).strict().optional(),
}).strict();

const EntityBaseShape = {
  id: IdSchema,
  revision: z.number().int().nonnegative(),
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
  createdBy: IdSchema,
  updatedBy: IdSchema,
};

const EntityBaseSchema = z.object(EntityBaseShape).strict();
const FadeSchema = z.object({ durationTicks: TickSchema, curve: z.enum(['linear', 'equal-power', 's-curve']) }).strict();

const TempoSchema = z.object({ ...EntityBaseShape, tick: TickSchema, bpm: FiniteSchema.min(20).max(400), curve: z.enum(['step', 'linear']) }).strict();
const MeterSchema = z.object({ ...EntityBaseShape, tick: TickSchema, numerator: z.number().int().min(1).max(32), denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]) }).strict();
const MarkerSchema = z.object({ ...EntityBaseShape, tick: TickSchema, endTick: TickSchema.optional(), name: z.string().min(1).max(200), color: z.string().max(40), kind: z.enum(['marker', 'region', 'cue']) }).strict();
const SectionSchema = z.object({ ...EntityBaseShape, name: z.string().min(1).max(200), startTick: TickSchema, endTick: TickSchema, color: z.string().max(40), energy: FiniteSchema.min(0).max(1).optional(), prompt: z.string().max(10_000).optional() }).strict();

const RoutingSchema = z.object({ outputTrackId: IdSchema.optional(), inputDeviceId: z.string().max(500).optional(), inputChannels: z.array(z.number().int().nonnegative()).max(64).optional(), midiInputDeviceId: z.string().max(500).optional(), midiOutputDeviceId: z.string().max(500).optional(), monitor: z.enum(['off', 'auto', 'on']) }).strict();
const TrackSchema = z.object({
  ...EntityBaseShape,
  kind: z.enum(['audio', 'instrument', 'midi', 'folder', 'aux', 'master']),
  name: z.string().min(1).max(200), color: z.string().max(40), parentId: IdSchema.optional(),
  clipIds: z.array(IdSchema), deviceIds: z.array(IdSchema), automationLaneIds: z.array(IdSchema), childTrackIds: z.array(IdSchema),
  gainDb: FiniteSchema.min(-120).max(24), pan: FiniteSchema.min(-1).max(1), mute: z.boolean(), solo: z.boolean(), armed: z.boolean(), frozen: z.boolean(), collapsed: z.boolean(), routing: RoutingSchema,
}).strict();

const WarpSchema = z.object({ ...EntityBaseShape, sourceSample: z.number().int().nonnegative(), projectTick: TickSchema }).strict();
const NoteSchema = z.object({ ...EntityBaseShape, startTick: TickSchema, durationTicks: z.number().int().positive(), pitch: z.number().int().min(0).max(127), velocity: FiniteSchema.min(0).max(1), releaseVelocity: FiniteSchema.min(0).max(1), channel: z.number().int().min(0).max(15), probability: FiniteSchema.min(0).max(1) }).strict();
const ControlSchema = z.object({ ...EntityBaseShape, tick: TickSchema, controller: z.number().int().min(0).max(127), value: FiniteSchema.min(0).max(1), channel: z.number().int().min(0).max(15) }).strict();
const PitchBendSchema = z.object({ ...EntityBaseShape, tick: TickSchema, value: FiniteSchema.min(-1).max(1), channel: z.number().int().min(0).max(15) }).strict();
const ClipBaseShape = {
  ...EntityBaseShape, trackId: IdSchema, name: z.string().min(1).max(200), color: z.string().max(40), startTick: TickSchema,
  durationTicks: z.number().int().positive(), muted: z.boolean(), gainDb: FiniteSchema.min(-120).max(24), fadeIn: FadeSchema, fadeOut: FadeSchema,
  loopEnabled: z.boolean(), loopLengthTicks: z.number().int().positive().optional(), takeLaneId: IdSchema.optional(),
};
const AudioClipSchema = z.object({ ...ClipBaseShape, kind: z.literal('audio'), assetId: IdSchema, sourceStartSample: z.number().int().nonnegative(), sourceDurationSamples: z.number().int().positive(), transposeSemitones: FiniteSchema.min(-48).max(48), stretchMode: z.enum(['repitch', 'stretch']), reverse: z.boolean(), warpMarkers: z.array(WarpSchema).max(100_000) }).strict();
const MidiClipSchema = z.object({ ...ClipBaseShape, kind: z.literal('midi'), notes: z.record(IdSchema, NoteSchema), noteOrder: z.array(IdSchema).max(1_000_000), controls: z.record(IdSchema, ControlSchema), controlOrder: z.array(IdSchema).max(1_000_000), pitchBends: z.record(IdSchema, PitchBendSchema), pitchBendOrder: z.array(IdSchema).max(1_000_000) }).strict();
const ClipSchema = z.discriminatedUnion('kind', [AudioClipSchema, MidiClipSchema]);

const TakeLaneSchema = z.object({ ...EntityBaseShape, trackId: IdSchema, name: z.string().min(1).max(200), clipIds: z.array(IdSchema), active: z.boolean() }).strict();
const CompSegmentSchema = z.object({ ...EntityBaseShape, trackId: IdSchema, takeLaneId: IdSchema, startTick: TickSchema, endTick: TickSchema }).strict();
const ParameterSchema = z.object({ id: z.string().min(1).max(500), name: z.string().min(1).max(500), value: FiniteSchema, defaultValue: FiniteSchema, min: FiniteSchema, max: FiniteSchema, unit: z.string().max(80).optional(), automatable: z.boolean() }).strict();
const DeviceSchema = z.object({
  ...EntityBaseShape, trackId: IdSchema, format: z.enum(['builtin', 'vst3', 'clap', 'missing']),
  builtinKind: z.enum(['sampler', 'drum-rack', 'subtractive-synth', 'utility', 'eq', 'compressor', 'gate', 'saturator', 'chorus', 'delay', 'reverb', 'limiter', 'analyzer']).optional(),
  pluginId: z.string().max(500).optional(), pluginVersion: z.string().max(100).optional(), pluginHash: z.string().max(128).optional(), name: z.string().min(1).max(500), vendor: z.string().max(500).optional(),
  bypassed: z.boolean(), degraded: z.boolean(), latencySamples: z.number().int().nonnegative(), stateAssetId: IdSchema.optional(), presetName: z.string().max(500).optional(), parameters: z.record(z.string(), ParameterSchema),
}).strict();
const SendSchema = z.object({ ...EntityBaseShape, sourceTrackId: IdSchema, destinationTrackId: IdSchema, gainDb: FiniteSchema.min(-120).max(24), preFader: z.boolean(), enabled: z.boolean() }).strict();
const SidechainSchema = z.object({ ...EntityBaseShape, sourceTrackId: IdSchema, destinationDeviceId: IdSchema, busIndex: z.number().int().nonnegative(), enabled: z.boolean() }).strict();
const PointSchema = z.object({ ...EntityBaseShape, tick: TickSchema, value: FiniteSchema, curve: z.enum(['hold', 'linear', 'bezier']), tension: FiniteSchema.min(-1).max(1).optional() }).strict();
const TargetSchema = z.union([z.object({ kind: z.literal('track'), parameter: z.enum(['gainDb', 'pan']) }).strict(), z.object({ kind: z.literal('device'), deviceId: IdSchema, parameterId: z.string().min(1).max(500) }).strict()]);
const LaneSchema = z.object({ ...EntityBaseShape, trackId: IdSchema, target: TargetSchema, points: z.record(IdSchema, PointSchema), pointOrder: z.array(IdSchema), armed: z.boolean(), visible: z.boolean() }).strict();

const AssetSchema = z.object({
  ...EntityBaseShape, kind: z.enum(['audio', 'midi', 'plugin-state', 'analysis', 'audition', 'checkpoint']), name: z.string().min(1).max(500), mimeType: z.string().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/i), byteLength: z.number().int().nonnegative(), storage: z.enum(['embedded', 'linked', 'managed-cache']),
  relativePath: z.string().max(2_000).optional(), externalPath: z.string().max(32_000).optional(), sampleRate: z.number().int().positive().optional(), channels: z.number().int().min(1).max(64).optional(), durationSamples: z.number().int().nonnegative().optional(), source: z.enum(['import', 'recording', 'generation', 'render', 'system']).optional(),
}).strict();
const ProvenanceSchema = z.object({ ...EntityBaseShape, assetId: IdSchema, provider: z.enum(['elevenlabs', 'stability', 'lyria']), model: z.string().min(1).max(300), modelVersion: z.string().max(100).optional(), kind: z.enum(['music', 'sfx', 'audio-to-audio', 'section-replace']), prompt: z.string().min(1).max(20_000), lyrics: z.string().max(200_000).optional(), referenceAssetIds: z.array(IdSchema).max(20), requestId: z.string().max(500).optional(), costMinor: z.number().int().nonnegative().optional(), currency: z.string().max(10).optional(), rightsDeclaration: z.enum(['original', 'licensed', 'owned-reference']), transformations: z.array(z.string().max(500)).max(200), experimental: z.boolean() }).strict();
const VariationSchema = z.object({ seed: z.number().int(), pitchRangeSemitones: FiniteSchema.min(0).max(24), gainRangeDb: FiniteSchema.min(0).max(24), timingRangeMilliseconds: FiniteSchema.min(0).max(5_000) }).strict();
const DeliverableSchema = z.object({ ...EntityBaseShape, name: z.string().min(1).max(500), startTick: TickSchema, endTick: TickSchema, variantCount: z.number().int().min(1).max(1000), tags: z.array(z.string().max(100)).max(100), seamlessLoop: z.boolean(), loopStartSample: z.number().int().nonnegative().optional(), loopEndSample: z.number().int().nonnegative().optional(), tailMilliseconds: z.number().int().min(0).max(60_000), variation: VariationSchema, targetLufs: FiniteSchema.min(-36).max(-5), namingTemplate: z.string().min(1).max(500), exportFormat: z.enum(['wav', 'flac', 'mp3']) }).strict();
const CheckpointSchema = z.object({ ...EntityBaseShape, name: z.string().min(1).max(500), projectRevision: z.number().int().nonnegative(), snapshotAssetId: IdSchema, automatic: z.boolean(), reason: z.string().max(2_000).optional() }).strict();
const VariantSchema = z.object({ ...EntityBaseShape, name: z.string().min(1).max(500), baseCheckpointId: IdSchema, snapshotAssetId: IdSchema.optional(), status: z.enum(['active', 'merged', 'discarded']), projectRevision: z.number().int().nonnegative() }).strict();
const ActivitySchema = z.object({ id: IdSchema, actor: ActorSchema, transactionId: IdSchema.optional(), label: z.string().min(1).max(500), status: z.enum(['committed', 'partial', 'conflict', 'failed', 'undo', 'redo', 'checkpoint']), createdAt: IsoSchema, revision: z.number().int().nonnegative(), details: z.record(z.string(), z.unknown()).optional() }).strict();

export const AIMuseProjectSchema = z.object({
  format: z.literal('AIMuse'), schemaVersion: z.literal(1), id: IdSchema, revision: z.number().int().nonnegative(), name: z.string().min(1).max(200), kind: z.enum(['song', 'sfx']), createdAt: IsoSchema, updatedAt: IsoSchema, createdBy: ActorSchema, dirty: z.boolean(), projectPath: z.string().max(32_000).optional(),
  settings: z.object({ sampleRate: z.union([z.literal(44_100), z.literal(48_000), z.literal(96_000)]), channelLayout: z.enum(['mono', 'stereo']), ppq: z.literal(960), recordBitDepth: z.union([z.literal(24), z.literal(32)]), countInBars: z.number().int().min(0).max(8), metronomeEnabled: z.boolean(), defaultCrossfadeTicks: TickSchema, masterLufsTarget: FiniteSchema.min(-36).max(-5) }).strict(),
  tempoEvents: z.record(IdSchema, TempoSchema), tempoOrder: z.array(IdSchema), timeSignatureEvents: z.record(IdSchema, MeterSchema), timeSignatureOrder: z.array(IdSchema), markers: z.record(IdSchema, MarkerSchema), markerOrder: z.array(IdSchema), sections: z.record(IdSchema, SectionSchema), sectionOrder: z.array(IdSchema), lyrics: z.string().max(200_000),
  tracks: z.record(IdSchema, TrackSchema), trackOrder: z.array(IdSchema), clips: z.record(IdSchema, ClipSchema), takeLanes: z.record(IdSchema, TakeLaneSchema), compSegments: z.record(IdSchema, CompSegmentSchema), devices: z.record(IdSchema, DeviceSchema), sends: z.record(IdSchema, SendSchema), sidechains: z.record(IdSchema, SidechainSchema), automationLanes: z.record(IdSchema, LaneSchema),
  assets: z.record(IdSchema, AssetSchema), provenance: z.record(IdSchema, ProvenanceSchema), sfxDeliverables: z.record(IdSchema, DeliverableSchema), checkpoints: z.record(IdSchema, CheckpointSchema), variants: z.record(IdSchema, VariantSchema), activity: z.array(ActivitySchema).max(10_000),
}).strict();

const OperationKinds = [
  'project.rename', 'project.settings.update', 'tempo.upsert', 'tempo.delete', 'meter.upsert', 'meter.delete', 'marker.add', 'marker.update', 'marker.delete',
  'section.add', 'section.update', 'section.delete', 'lyrics.set', 'track.add', 'track.update', 'track.move', 'track.delete', 'clip.add', 'clip.update', 'clip.move', 'clip.trim', 'clip.split', 'clip.delete',
  'take-lane.add', 'take-lane.update', 'take-lane.delete', 'comp-segment.upsert', 'comp-segment.delete', 'midi.note.add', 'midi.note.update', 'midi.note.delete', 'midi.control.add', 'midi.control.delete', 'midi.pitch-bend.add', 'midi.pitch-bend.update', 'midi.pitch-bend.delete', 'midi.semantic',
  'automation.lane.add', 'automation.lane.update', 'automation.lane.delete', 'automation.point.upsert', 'automation.point.delete', 'device.add', 'device.update', 'device.move', 'device.parameter.set', 'device.delete',
  'send.upsert', 'send.delete', 'sidechain.upsert', 'sidechain.delete', 'asset.add', 'asset.delete', 'provenance.register', 'provenance.update', 'sfx-deliverable.add', 'sfx-deliverable.update', 'sfx-deliverable.delete', 'checkpoint.register', 'checkpoint.delete', 'variant.register', 'variant.update',
] as const;

const RawOperationSchema = z.object({ kind: z.enum(OperationKinds) }).loose();
const ExpectedSchema = z.object({ expectedRevision: z.number().int().nonnegative().optional() }).loose();

function validateOperation(value: unknown): ProjectOperation {
  const raw = RawOperationSchema.parse(value) as Record<string, unknown> & { kind: ProjectOperation['kind'] };
  ExpectedSchema.parse(value);
  const parse = <T>(schema: z.ZodType<T>): T => schema.parse(value);
  switch (raw.kind) {
    case 'project.rename': return parse(z.object({ kind: z.literal(raw.kind), name: z.string().min(1).max(200) }).strict()) as ProjectOperation;
    case 'project.settings.update': return parse(z.object({ kind: z.literal(raw.kind), changes: z.object({ sampleRate: z.union([z.literal(44_100), z.literal(48_000), z.literal(96_000)]).optional(), channelLayout: z.enum(['mono', 'stereo']).optional(), ppq: z.literal(960).optional(), recordBitDepth: z.union([z.literal(24), z.literal(32)]).optional(), countInBars: z.number().int().min(0).max(8).optional(), metronomeEnabled: z.boolean().optional(), defaultCrossfadeTicks: TickSchema.optional(), masterLufsTarget: FiniteSchema.min(-36).max(-5).optional() }).strict() }).strict()) as ProjectOperation;
    case 'tempo.upsert': return parse(z.object({ kind: z.literal(raw.kind), event: TempoSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'tempo.delete': case 'meter.delete': return parse(z.object({ kind: z.literal(raw.kind), eventId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'meter.upsert': return parse(z.object({ kind: z.literal(raw.kind), event: MeterSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'marker.add': return parse(z.object({ kind: z.literal(raw.kind), marker: MarkerSchema, index: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'marker.update': return parse(z.object({ kind: z.literal(raw.kind), markerId: IdSchema, changes: z.object({ tick: TickSchema.optional(), endTick: TickSchema.optional(), name: z.string().min(1).max(200).optional(), color: z.string().max(40).optional(), kind: z.enum(['marker', 'region', 'cue']).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'marker.delete': return parse(z.object({ kind: z.literal(raw.kind), markerId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'section.add': return parse(z.object({ kind: z.literal(raw.kind), section: SectionSchema, index: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'section.update': return parse(z.object({ kind: z.literal(raw.kind), sectionId: IdSchema, changes: z.object({ name: z.string().min(1).max(200).optional(), startTick: TickSchema.optional(), endTick: TickSchema.optional(), color: z.string().max(40).optional(), energy: FiniteSchema.min(0).max(1).optional(), prompt: z.string().max(10_000).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'section.delete': return parse(z.object({ kind: z.literal(raw.kind), sectionId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'lyrics.set': return parse(z.object({ kind: z.literal(raw.kind), lyrics: z.string().max(200_000) }).strict()) as ProjectOperation;
    case 'track.add': return parse(z.object({ kind: z.literal(raw.kind), track: TrackSchema, index: z.number().int().nonnegative().optional(), parentId: IdSchema.optional() }).strict()) as ProjectOperation;
    case 'track.update': return parse(z.object({ kind: z.literal(raw.kind), trackId: IdSchema, changes: z.object({ name: z.string().min(1).max(200).optional(), color: z.string().max(40).optional(), gainDb: FiniteSchema.min(-120).max(24).optional(), pan: FiniteSchema.min(-1).max(1).optional(), mute: z.boolean().optional(), solo: z.boolean().optional(), armed: z.boolean().optional(), frozen: z.boolean().optional(), collapsed: z.boolean().optional(), routing: RoutingSchema.optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'track.move': return parse(z.object({ kind: z.literal(raw.kind), trackId: IdSchema, index: z.number().int().nonnegative(), parentId: IdSchema.optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'track.delete': return parse(z.object({ kind: z.literal(raw.kind), trackId: IdSchema, cascade: z.boolean(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.add': return parse(z.object({ kind: z.literal(raw.kind), clip: ClipSchema, index: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.update': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, changes: z.object({ name: z.string().min(1).max(200).optional(), color: z.string().max(40).optional(), startTick: TickSchema.optional(), durationTicks: z.number().int().positive().optional(), muted: z.boolean().optional(), gainDb: FiniteSchema.min(-120).max(24).optional(), fadeIn: FadeSchema.optional(), fadeOut: FadeSchema.optional(), loopEnabled: z.boolean().optional(), loopLengthTicks: z.number().int().positive().optional(), sourceStartSample: z.number().int().nonnegative().optional(), sourceDurationSamples: z.number().int().positive().optional(), transposeSemitones: FiniteSchema.min(-48).max(48).optional(), stretchMode: z.enum(['repitch', 'stretch']).optional(), reverse: z.boolean().optional(), warpMarkers: z.array(WarpSchema).max(100_000).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.move': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, trackId: IdSchema, startTick: TickSchema, index: z.number().int().nonnegative().optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.trim': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, startTick: TickSchema, durationTicks: z.number().int().positive(), sourceStartSample: z.number().int().nonnegative().optional(), sourceDurationSamples: z.number().int().positive().optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.split': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, tick: TickSchema, rightClip: ClipSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'clip.delete': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'take-lane.add': return parse(z.object({ kind: z.literal(raw.kind), lane: TakeLaneSchema }).strict()) as ProjectOperation;
    case 'take-lane.update': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, changes: z.object({ name: z.string().min(1).max(200).optional(), active: z.boolean().optional(), clipIds: z.array(IdSchema).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'take-lane.delete': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'comp-segment.upsert': return parse(z.object({ kind: z.literal(raw.kind), segment: CompSegmentSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'comp-segment.delete': return parse(z.object({ kind: z.literal(raw.kind), segmentId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.note.add': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, note: NoteSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.note.update': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, noteId: IdSchema, changes: z.object({ startTick: TickSchema.optional(), durationTicks: z.number().int().positive().optional(), pitch: z.number().int().min(0).max(127).optional(), velocity: FiniteSchema.min(0).max(1).optional(), releaseVelocity: FiniteSchema.min(0).max(1).optional(), channel: z.number().int().min(0).max(15).optional(), probability: FiniteSchema.min(0).max(1).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.note.delete': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, noteId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.control.add': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, event: ControlSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.control.delete': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, eventId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.pitch-bend.add': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, event: PitchBendSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.pitch-bend.update': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, eventId: IdSchema, changes: z.object({ tick: TickSchema.optional(), value: FiniteSchema.min(-1).max(1).optional(), channel: z.number().int().min(0).max(15).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.pitch-bend.delete': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, eventId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'midi.semantic': return parse(z.object({ kind: z.literal(raw.kind), clipId: IdSchema, noteIds: z.array(IdSchema).max(100_000).optional(), action: z.enum(['quantize', 'humanize', 'transpose', 'legato', 'duplicate', 'arpeggiate']), gridTicks: z.number().int().positive().optional(), strength: FiniteSchema.min(0).max(1).optional(), seed: z.number().int().optional(), timingTicks: z.number().int().nonnegative().optional(), velocityAmount: FiniteSchema.min(0).max(1).optional(), semitones: z.number().int().min(-127).max(127).optional(), gapTicks: z.number().int().optional(), offsetTicks: z.number().int().optional(), stepTicks: z.number().int().positive().optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'automation.lane.add': return parse(z.object({ kind: z.literal(raw.kind), lane: LaneSchema }).strict()) as ProjectOperation;
    case 'automation.lane.update': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, changes: z.object({ armed: z.boolean().optional(), visible: z.boolean().optional(), target: TargetSchema.optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'automation.lane.delete': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'automation.point.upsert': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, point: PointSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'automation.point.delete': return parse(z.object({ kind: z.literal(raw.kind), laneId: IdSchema, pointId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'device.add': return parse(z.object({ kind: z.literal(raw.kind), device: DeviceSchema, index: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'device.update': return parse(z.object({ kind: z.literal(raw.kind), deviceId: IdSchema, changes: z.object({ name: z.string().min(1).max(500).optional(), bypassed: z.boolean().optional(), degraded: z.boolean().optional(), latencySamples: z.number().int().nonnegative().optional(), stateAssetId: IdSchema.optional(), presetName: z.string().max(500).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'device.move': return parse(z.object({ kind: z.literal(raw.kind), deviceId: IdSchema, trackId: IdSchema, index: z.number().int().nonnegative(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'device.parameter.set': return parse(z.object({ kind: z.literal(raw.kind), deviceId: IdSchema, parameterId: z.string().min(1).max(500), value: FiniteSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'device.delete': return parse(z.object({ kind: z.literal(raw.kind), deviceId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'send.upsert': return parse(z.object({ kind: z.literal(raw.kind), send: SendSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'send.delete': return parse(z.object({ kind: z.literal(raw.kind), sendId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'sidechain.upsert': return parse(z.object({ kind: z.literal(raw.kind), route: SidechainSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'sidechain.delete': return parse(z.object({ kind: z.literal(raw.kind), routeId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'asset.add': return parse(z.object({ kind: z.literal(raw.kind), asset: AssetSchema }).strict()) as ProjectOperation;
    case 'asset.delete': return parse(z.object({ kind: z.literal(raw.kind), assetId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'provenance.register': return parse(z.object({ kind: z.literal(raw.kind), provenance: ProvenanceSchema }).strict()) as ProjectOperation;
    case 'provenance.update': return parse(z.object({ kind: z.literal(raw.kind), provenanceId: IdSchema, changes: z.object({ transformations: z.array(z.string().max(500)).max(200).optional(), modelVersion: z.string().max(100).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'sfx-deliverable.add': return parse(z.object({ kind: z.literal(raw.kind), deliverable: DeliverableSchema }).strict()) as ProjectOperation;
    case 'sfx-deliverable.update': return parse(z.object({ kind: z.literal(raw.kind), deliverableId: IdSchema, changes: z.object({ name: z.string().min(1).max(500).optional(), startTick: TickSchema.optional(), endTick: TickSchema.optional(), variantCount: z.number().int().min(1).max(1000).optional(), tags: z.array(z.string().max(100)).max(100).optional(), seamlessLoop: z.boolean().optional(), loopStartSample: z.number().int().nonnegative().optional(), loopEndSample: z.number().int().nonnegative().optional(), tailMilliseconds: z.number().int().min(0).max(60_000).optional(), variation: VariationSchema.optional(), targetLufs: FiniteSchema.min(-36).max(-5).optional(), namingTemplate: z.string().min(1).max(500).optional(), exportFormat: z.enum(['wav', 'flac', 'mp3']).optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'sfx-deliverable.delete': return parse(z.object({ kind: z.literal(raw.kind), deliverableId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'checkpoint.register': return parse(z.object({ kind: z.literal(raw.kind), checkpoint: CheckpointSchema }).strict()) as ProjectOperation;
    case 'checkpoint.delete': return parse(z.object({ kind: z.literal(raw.kind), checkpointId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
    case 'variant.register': return parse(z.object({ kind: z.literal(raw.kind), variant: VariantSchema }).strict()) as ProjectOperation;
    case 'variant.update': return parse(z.object({ kind: z.literal(raw.kind), variantId: IdSchema, changes: z.object({ name: z.string().min(1).max(500).optional(), status: z.enum(['active', 'merged', 'discarded']).optional(), projectRevision: z.number().int().nonnegative().optional(), snapshotAssetId: IdSchema.optional() }).strict(), expectedRevision: z.number().int().nonnegative().optional() }).strict()) as ProjectOperation;
  }
}

export const ProjectTransactionSchema = z.object({
  id: IdSchema,
  clientOperationId: z.string().min(1).max(240),
  projectId: IdSchema,
  actor: ActorSchema,
  label: z.string().min(1).max(500),
  createdAt: IsoSchema,
  operations: z.array(z.unknown()).min(1).max(512).transform((operations) => operations.map(validateOperation)),
  checkpointPolicy: z.enum(['none', 'auto', 'required']).optional(),
}).strict() as z.ZodType<ProjectTransaction>;

export function validateProject(value: unknown): AIMuseProject {
  const project = AIMuseProjectSchema.parse(value) as AIMuseProject;
  validateProjectIntegrity(project);
  return project;
}

export function validateTransaction(value: unknown): ProjectTransaction {
  return ProjectTransactionSchema.parse(value);
}

export { ActorSchema, EntityBaseSchema, AssetSchema };
