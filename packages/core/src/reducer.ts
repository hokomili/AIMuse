import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { declaredActorError, declaredEntityBaseError, declaredProjectRootError, isDeclaredId, isDeclaredIsoTimestamp } from './declared-values';
import { createId, nowIso } from './ids';
import type { ActivityEntry, AIMuseProject, Actor, AutomationLane, AutomationPoint, Checkpoint, Clip, CompSegment, Device, DeviceParameter, EntityBase, GenerationProvenance, Id, Marker, MediaAsset, MidiControlEvent, MidiNote, MidiPitchBendEvent, Send, SidechainRoute, SongSection, TakeLane, TempoEvent, TimeSignatureEvent, Track, Variant } from './model';
import { TransactionConflictError, type ProjectOperation, type ProjectTransaction } from './operations';

enablePatches();

export const MAX_RECENT_ACTIVITY_ENTRIES = 2_000;
const MAX_STORED_ACTIVITY_ENTRIES = 10_000;

export interface ReducerOptions {
  authenticatedActor?: Actor;
  maxOperations?: number;
}

export interface ReducerResult {
  project: AIMuseProject;
  transaction: ProjectTransaction;
  patches: Patch[];
  inversePatches: Patch[];
}

function conflict(operationIndex: number, message: string, entity?: EntityBase, expectedRevision?: number, retryable = false): never {
  throw new TransactionConflictError({ operationIndex, entityId: entity?.id, expectedRevision, actualRevision: entity?.revision, message, retryable });
}

function expectEntity<T extends EntityBase>(value: T | undefined, operationIndex: number, label: string, expectedRevision?: number): T {
  if (!value) conflict(operationIndex, `${label} does not exist.`);
  if (expectedRevision !== undefined && value.revision !== expectedRevision) {
    conflict(operationIndex, `${label} changed from revision ${expectedRevision} to ${value.revision}.`, value, expectedRevision, true);
  }
  return value;
}

function normalizeNewEntity<T extends EntityBase>(entity: T, actor: Actor, timestamp: string): T {
  return { ...entity, revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actor.id, updatedBy: actor.id };
}

function touch<T extends EntityBase>(entity: T, actor: Actor, timestamp: string): void {
  entity.revision += 1;
  entity.updatedAt = timestamp;
  entity.updatedBy = actor.id;
}

function insertAt<T>(values: T[], value: T, index?: number): void {
  const target = index === undefined ? values.length : Math.max(0, Math.min(index, values.length));
  values.splice(target, 0, value);
}

function removeFrom<T>(values: T[], value: T): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function assertFinite(value: number, operationIndex: number, label: string, min?: number, max?: number): void {
  if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    conflict(operationIndex, `${label} is outside its supported range.`);
  }
}

function assertDeclaredEntityBase(entity: EntityBase, operationIndex: number, label: string): void {
  const entityError = declaredEntityBaseError(entity, label);
  if (entityError) conflict(operationIndex, entityError, entity);
}

function declaredProjectSettingsError(settings: AIMuseProject['settings'] | null | undefined): string | undefined {
  if (!settings || typeof settings !== 'object') return 'Project settings are missing.';
  if (![44_100, 48_000, 96_000].includes(settings.sampleRate)) return 'Unsupported sample rate.';
  if (!['mono', 'stereo'].includes(settings.channelLayout)) return 'Unsupported channel layout.';
  if (settings.ppq !== 960) return 'Project PPQ must be 960.';
  if (![24, 32].includes(settings.recordBitDepth)) return 'Unsupported record bit depth.';
  if (!Number.isInteger(settings.countInBars) || settings.countInBars < 0 || settings.countInBars > 8) return 'Count-in bars must be an integer from 0 through 8.';
  if (typeof settings.metronomeEnabled !== 'boolean') return 'Metronome setting must be boolean.';
  if (!Number.isInteger(settings.defaultCrossfadeTicks) || settings.defaultCrossfadeTicks < 0) return 'Default crossfade ticks must be a nonnegative integer.';
  if (!Number.isFinite(settings.masterLufsTarget) || settings.masterLufsTarget < -36 || settings.masterLufsTarget > -5) return 'LUFS target is outside its supported range.';
  return undefined;
}

function declaredActivityError(entry: ActivityEntry | null | undefined): string | undefined {
  if (!entry || typeof entry !== 'object' || !isDeclaredId(entry.id)) return 'Activity entry has an invalid ID.';
  const actorError = declaredActorError(entry.actor, 'Activity actor');
  if (actorError) return actorError;
  if (entry.transactionId !== undefined && !isDeclaredId(entry.transactionId)) return `Activity ${entry.id} has an invalid transaction ID.`;
  if (typeof entry.label !== 'string' || entry.label.length < 1 || entry.label.length > 500) return `Activity ${entry.id} has an invalid label.`;
  if (!['committed', 'partial', 'conflict', 'failed', 'undo', 'redo', 'checkpoint'].includes(entry.status)) return `Activity ${entry.id} has an invalid status.`;
  if (!isDeclaredIsoTimestamp(entry.createdAt)) return `Activity ${entry.id} has an invalid timestamp.`;
  if (!Number.isInteger(entry.revision) || entry.revision < 0) return `Activity ${entry.id} has an invalid revision.`;
  if (entry.details !== undefined) {
    if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) return `Activity ${entry.id} has invalid details.`;
    const prototype = Object.getPrototypeOf(entry.details);
    if (prototype !== Object.prototype && prototype !== null) return `Activity ${entry.id} has invalid details.`;
  }
  return undefined;
}

function trimRecentActivity(activity: ActivityEntry[]): void {
  if (activity.length > MAX_RECENT_ACTIVITY_ENTRIES) activity.splice(0, activity.length - MAX_RECENT_ACTIVITY_ENTRIES);
}

function declaredTrackMutableError(track: Track): string | undefined {
  if (typeof track.name !== 'string' || track.name.length < 1 || track.name.length > 200) return `Track ${track.id} has an invalid name.`;
  if (typeof track.color !== 'string' || track.color.length > 40) return `Track ${track.id} has an invalid color.`;
  if (!Number.isFinite(track.gainDb) || track.gainDb < -120 || track.gainDb > 24 || !Number.isFinite(track.pan) || track.pan < -1 || track.pan > 1) return `Track ${track.id} has invalid gain or pan.`;
  if ([track.mute, track.solo, track.armed, track.frozen, track.collapsed].some((value) => typeof value !== 'boolean')) return `Track ${track.id} has invalid state flags.`;
  const routing = track.routing;
  if (!routing || typeof routing !== 'object') return `Track ${track.id} has invalid routing values.`;
  if (routing.outputTrackId !== undefined && (typeof routing.outputTrackId !== 'string' || routing.outputTrackId.length < 1 || routing.outputTrackId.length > 240)) return `Track ${track.id} has invalid routing values.`;
  if (routing.inputDeviceId !== undefined && (typeof routing.inputDeviceId !== 'string' || routing.inputDeviceId.length > 500)) return `Track ${track.id} has invalid routing values.`;
  if (routing.inputChannels !== undefined && (!Array.isArray(routing.inputChannels) || routing.inputChannels.length > 64 || routing.inputChannels.some((channel) => !Number.isInteger(channel) || channel < 0))) return `Track ${track.id} has invalid routing values.`;
  if (routing.midiInputDeviceId !== undefined && (typeof routing.midiInputDeviceId !== 'string' || routing.midiInputDeviceId.length > 500)) return `Track ${track.id} has invalid routing values.`;
  if (routing.midiOutputDeviceId !== undefined && (typeof routing.midiOutputDeviceId !== 'string' || routing.midiOutputDeviceId.length > 500)) return `Track ${track.id} has invalid routing values.`;
  if (!['off', 'auto', 'on'].includes(routing.monitor)) return `Track ${track.id} has invalid routing values.`;
  return undefined;
}

function declaredTrackKindError(track: Track): string | undefined {
  if (!['audio', 'instrument', 'midi', 'folder', 'aux', 'master'].includes(track.kind)) return `Track ${track.id} has an invalid kind.`;
  return undefined;
}

function assertDeclaredTrackKind(track: Track, operationIndex: number): void {
  const kindError = declaredTrackKindError(track);
  if (kindError) conflict(operationIndex, kindError);
}

function declaredClipMutableError(clip: Clip): string | undefined {
  if (typeof clip.name !== 'string' || clip.name.length < 1 || clip.name.length > 200 || typeof clip.color !== 'string' || clip.color.length > 40) return `Clip ${clip.id} has invalid text values.`;
  if (typeof clip.muted !== 'boolean' || typeof clip.loopEnabled !== 'boolean') return `Clip ${clip.id} has invalid state flags.`;
  const hasDeclaredCurve = (fade: Clip['fadeIn'] | null | undefined): boolean =>
    Boolean(fade && typeof fade === 'object' && ['linear', 'equal-power', 's-curve'].includes((fade as { curve?: unknown }).curve as string));
  if (!hasDeclaredCurve(clip.fadeIn) || !hasDeclaredCurve(clip.fadeOut)) return `Clip ${clip.id} has invalid fade values.`;
  if (clip.kind === 'audio' && (!['repitch', 'stretch'].includes(clip.stretchMode) || typeof clip.reverse !== 'boolean')) return `Audio clip ${clip.id} has invalid playback values.`;
  return undefined;
}

function declaredClipNumericError(clip: Clip): string | undefined {
  if (!Number.isSafeInteger(clip.startTick) || clip.startTick < 0 || !Number.isSafeInteger(clip.durationTicks) || clip.durationTicks < 1 || !Number.isFinite(clip.gainDb) || clip.gainDb < -120 || clip.gainDb > 24) return `Clip ${clip.id} has invalid timing or gain.`;
  const fadeInDuration = (clip.fadeIn as { durationTicks?: unknown } | null | undefined)?.durationTicks;
  const fadeOutDuration = (clip.fadeOut as { durationTicks?: unknown } | null | undefined)?.durationTicks;
  if (!Number.isSafeInteger(fadeInDuration) || (fadeInDuration as number) < 0 || !Number.isSafeInteger(fadeOutDuration) || (fadeOutDuration as number) < 0 || (clip.loopLengthTicks !== undefined && (!Number.isSafeInteger(clip.loopLengthTicks) || clip.loopLengthTicks < 1))) return `Clip ${clip.id} has invalid fade or loop timing.`;
  return undefined;
}

function assertDeclaredClipNumeric(clip: Clip, operationIndex: number): void {
  const numericError = declaredClipNumericError(clip);
  if (numericError) conflict(operationIndex, numericError);
}

function declaredAudioClipSourceError(project: AIMuseProject, clip: Extract<Clip, { kind: 'audio' }>): string | undefined {
  if (!isDeclaredId(clip.assetId) || !project.assets[clip.assetId]) return `Audio clip ${clip.id} references missing media.`;
  if (!Number.isSafeInteger(clip.sourceStartSample) || clip.sourceStartSample < 0 || !Number.isSafeInteger(clip.sourceDurationSamples) || clip.sourceDurationSamples < 1 || !Number.isFinite(clip.transposeSemitones) || clip.transposeSemitones < -48 || clip.transposeSemitones > 48) return `Audio clip ${clip.id} has invalid source bounds.`;
  return undefined;
}

function assertDeclaredAudioClipSource(project: AIMuseProject, clip: Extract<Clip, { kind: 'audio' }>, operationIndex: number): void {
  const sourceError = declaredAudioClipSourceError(project, clip);
  if (sourceError) conflict(operationIndex, sourceError);
}

function declaredDeviceMutableError(device: Device): string | undefined {
  if (typeof device.name !== 'string' || device.name.length < 1 || device.name.length > 500) return `Device ${device.id} has an invalid name.`;
  if (typeof device.bypassed !== 'boolean' || typeof device.degraded !== 'boolean') return `Device ${device.id} has invalid state flags.`;
  if (!Number.isSafeInteger(device.latencySamples) || device.latencySamples < 0) return `Device ${device.id} has invalid latency.`;
  if (device.stateAssetId !== undefined && (typeof device.stateAssetId !== 'string' || device.stateAssetId.length < 1 || device.stateAssetId.length > 240)) return `Device ${device.id} has an invalid state asset ID.`;
  if (device.presetName !== undefined && (typeof device.presetName !== 'string' || device.presetName.length > 500)) return `Device ${device.id} has an invalid preset name.`;
  return undefined;
}

function declaredDeviceParameterError(key: string, parameter: DeviceParameter | null | undefined, deviceId: Id): string | undefined {
  if (!parameter || typeof parameter !== 'object' || parameter.id !== key || typeof parameter.id !== 'string' || parameter.id.length < 1 || parameter.id.length > 500 || typeof parameter.name !== 'string' || parameter.name.length < 1 || parameter.name.length > 500 || (parameter.unit !== undefined && (typeof parameter.unit !== 'string' || parameter.unit.length > 80)) || typeof parameter.automatable !== 'boolean') return `Device ${deviceId} has an invalid parameter descriptor.`;
  if (![parameter.value, parameter.defaultValue, parameter.min, parameter.max].every(Number.isFinite) || parameter.min > parameter.max || parameter.value < parameter.min || parameter.value > parameter.max || parameter.defaultValue < parameter.min || parameter.defaultValue > parameter.max) return `Device ${deviceId} has invalid parameter bounds.`;
  return undefined;
}

function declaredDeviceParametersError(device: Device): string | undefined {
  if (!device.parameters || typeof device.parameters !== 'object' || Array.isArray(device.parameters)) return `Device ${device.id} has invalid parameter descriptors.`;
  for (const [key, parameter] of Object.entries(device.parameters)) {
    const parameterError = declaredDeviceParameterError(key, parameter, device.id);
    if (parameterError) return parameterError;
  }
  return undefined;
}

function declaredDeviceError(device: Device): string | undefined {
  if (!isDeclaredId(device.trackId)) return `Device ${device.id} has an invalid track ID.`;
  if (!['builtin', 'vst3', 'clap', 'missing'].includes(device.format)) return `Device ${device.id} has an invalid format.`;
  if (device.builtinKind !== undefined && !['sampler', 'drum-rack', 'subtractive-synth', 'utility', 'eq', 'compressor', 'gate', 'saturator', 'chorus', 'delay', 'reverb', 'limiter', 'analyzer'].includes(device.builtinKind)) return `Device ${device.id} has an invalid built-in kind.`;
  if (device.pluginId !== undefined && (typeof device.pluginId !== 'string' || device.pluginId.length > 500)) return `Device ${device.id} has an invalid plug-in ID.`;
  if (device.pluginVersion !== undefined && (typeof device.pluginVersion !== 'string' || device.pluginVersion.length > 100)) return `Device ${device.id} has an invalid plug-in version.`;
  if (device.pluginHash !== undefined && (typeof device.pluginHash !== 'string' || device.pluginHash.length > 128)) return `Device ${device.id} has an invalid plug-in hash.`;
  if (device.vendor !== undefined && (typeof device.vendor !== 'string' || device.vendor.length > 500)) return `Device ${device.id} has an invalid vendor.`;
  return declaredDeviceMutableError(device) ?? declaredDeviceParametersError(device);
}

function assertDeclaredDevice(device: Device, operationIndex: number): void {
  assertDeclaredEntityBase(device, operationIndex, 'Device');
  const deviceError = declaredDeviceError(device);
  if (deviceError) conflict(operationIndex, deviceError);
}

function declaredSendValueError(send: Send): string | undefined {
  if (!Number.isFinite(send.gainDb) || send.gainDb < -120 || send.gainDb > 24) return `Send ${send.id} has invalid gain.`;
  if (typeof send.preFader !== 'boolean' || typeof send.enabled !== 'boolean') return `Send ${send.id} has invalid state flags.`;
  return undefined;
}

function declaredSidechainValueError(route: SidechainRoute): string | undefined {
  if (!Number.isInteger(route.busIndex) || route.busIndex < 0) return `Sidechain ${route.id} has an invalid bus index.`;
  if (typeof route.enabled !== 'boolean') return `Sidechain ${route.id} has an invalid state flag.`;
  return undefined;
}

function declaredTakeLaneMutableError(lane: TakeLane): string | undefined {
  if (typeof lane.name !== 'string' || lane.name.length < 1 || lane.name.length > 200) return `Take lane ${lane.id} has an invalid name.`;
  if (typeof lane.active !== 'boolean') return `Take lane ${lane.id} has an invalid active state.`;
  return undefined;
}

function declaredCompSegmentError(project: AIMuseProject, segment: CompSegment): string | undefined {
  if (!isDeclaredId(segment.trackId) || !isDeclaredId(segment.takeLaneId)) return `Comp segment ${segment.id} references an invalid track or take lane.`;
  const lane = project.takeLanes[segment.takeLaneId];
  if (!project.tracks[segment.trackId] || !lane || lane.trackId !== segment.trackId) return `Comp segment ${segment.id} references an invalid track or take lane.`;
  if (!Number.isSafeInteger(segment.startTick) || segment.startTick < 0 || !Number.isSafeInteger(segment.endTick) || segment.endTick < 0 || segment.endTick <= segment.startTick) return `Comp segment ${segment.id} must have a non-empty forward range.`;
  return undefined;
}

function declaredMediaAssetError(asset: MediaAsset): string | undefined {
  if (!['audio', 'midi', 'plugin-state', 'analysis', 'audition', 'checkpoint'].includes(asset.kind)) return `Media asset ${asset.id} has an invalid kind.`;
  if (typeof asset.name !== 'string' || asset.name.length < 1 || asset.name.length > 500) return `Media asset ${asset.id} has an invalid name.`;
  if (typeof asset.mimeType !== 'string' || asset.mimeType.length < 1 || asset.mimeType.length > 200) return `Media asset ${asset.id} has an invalid MIME type.`;
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) return `Media asset ${asset.id} has an invalid SHA-256.`;
  if (!Number.isInteger(asset.byteLength) || asset.byteLength < 0) return `Media asset ${asset.id} has an invalid byte length.`;
  if (!['embedded', 'linked', 'managed-cache'].includes(asset.storage)) return `Media asset ${asset.id} has an invalid storage value.`;
  if (asset.relativePath !== undefined && (typeof asset.relativePath !== 'string' || asset.relativePath.length > 2_000)) return `Media asset ${asset.id} has invalid path metadata.`;
  if (asset.externalPath !== undefined && (typeof asset.externalPath !== 'string' || asset.externalPath.length > 32_000)) return `Media asset ${asset.id} has invalid path metadata.`;
  if (asset.sampleRate !== undefined && (!Number.isInteger(asset.sampleRate) || asset.sampleRate < 1)) return `Media asset ${asset.id} has invalid audio metadata.`;
  if (asset.channels !== undefined && (!Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 64)) return `Media asset ${asset.id} has invalid audio metadata.`;
  if (asset.durationSamples !== undefined && (!Number.isInteger(asset.durationSamples) || asset.durationSamples < 0)) return `Media asset ${asset.id} has invalid audio metadata.`;
  if (asset.source !== undefined && !['import', 'recording', 'generation', 'render', 'system'].includes(asset.source)) return `Media asset ${asset.id} has an invalid source.`;
  return undefined;
}

function declaredCheckpointError(checkpoint: Checkpoint): string | undefined {
  if (typeof checkpoint.name !== 'string' || checkpoint.name.length < 1 || checkpoint.name.length > 500) return `Checkpoint ${checkpoint.id} has an invalid name.`;
  if (!Number.isInteger(checkpoint.projectRevision) || checkpoint.projectRevision < 0) return `Checkpoint ${checkpoint.id} has an invalid project revision.`;
  if (typeof checkpoint.snapshotAssetId !== 'string' || checkpoint.snapshotAssetId.length < 1 || checkpoint.snapshotAssetId.length > 240) return `Checkpoint ${checkpoint.id} has an invalid snapshot asset ID.`;
  if (typeof checkpoint.automatic !== 'boolean') return `Checkpoint ${checkpoint.id} has an invalid automatic value.`;
  if (checkpoint.reason !== undefined && (typeof checkpoint.reason !== 'string' || checkpoint.reason.length > 2_000)) return `Checkpoint ${checkpoint.id} has an invalid reason.`;
  return undefined;
}

function declaredProvenanceMutableError(value: GenerationProvenance): string | undefined {
  if (value.modelVersion !== undefined && (typeof value.modelVersion !== 'string' || value.modelVersion.length > 100)) return `Generation provenance ${value.id} has an invalid model version.`;
  if (!Array.isArray(value.transformations) || value.transformations.length > 200 || value.transformations.some((transformation) => typeof transformation !== 'string' || transformation.length > 500)) return `Generation provenance ${value.id} has invalid transformations.`;
  return undefined;
}

function declaredProvenanceError(value: GenerationProvenance): string | undefined {
  if (!isDeclaredId(value.assetId)) return `Generation provenance ${value.id} has an invalid asset ID.`;
  if (!['elevenlabs', 'stability', 'lyria'].includes(value.provider)) return `Generation provenance ${value.id} has an invalid provider.`;
  if (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 300) return `Generation provenance ${value.id} has an invalid model.`;
  if (!['music', 'sfx', 'audio-to-audio', 'section-replace'].includes(value.kind)) return `Generation provenance ${value.id} has an invalid kind.`;
  if (typeof value.prompt !== 'string' || value.prompt.length < 1 || value.prompt.length > 20_000) return `Generation provenance ${value.id} has an invalid prompt.`;
  if (value.lyrics !== undefined && (typeof value.lyrics !== 'string' || value.lyrics.length > 200_000)) return `Generation provenance ${value.id} has invalid lyrics.`;
  if (!Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 20 || value.referenceAssetIds.some((id) => !isDeclaredId(id))) return `Generation provenance ${value.id} has invalid reference asset IDs.`;
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || value.requestId.length > 500)) return `Generation provenance ${value.id} has an invalid request ID.`;
  if (value.costMinor !== undefined && (!Number.isInteger(value.costMinor) || value.costMinor < 0)) return `Generation provenance ${value.id} has an invalid cost.`;
  if (value.currency !== undefined && (typeof value.currency !== 'string' || value.currency.length > 10)) return `Generation provenance ${value.id} has an invalid currency.`;
  if (!['original', 'licensed', 'owned-reference'].includes(value.rightsDeclaration)) return `Generation provenance ${value.id} has an invalid rights declaration.`;
  const mutableError = declaredProvenanceMutableError(value);
  if (mutableError) return mutableError;
  if (typeof value.experimental !== 'boolean') return `Generation provenance ${value.id} has an invalid experimental value.`;
  return undefined;
}

function declaredVariantMutableError(value: Variant): string | undefined {
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 500) return `Variant ${value.id} has an invalid name.`;
  if (!['active', 'merged', 'discarded'].includes(value.status)) return `Variant ${value.id} has an invalid status.`;
  if (!Number.isInteger(value.projectRevision) || value.projectRevision < 0) return `Variant ${value.id} has an invalid project revision.`;
  if (value.snapshotAssetId !== undefined && (typeof value.snapshotAssetId !== 'string' || value.snapshotAssetId.length < 1 || value.snapshotAssetId.length > 240)) return `Variant ${value.id} has an invalid snapshot asset ID.`;
  return undefined;
}

function declaredMarkerTextError(marker: Marker): string | undefined {
  if (typeof marker.name !== 'string' || marker.name.length < 1 || marker.name.length > 200) return `Marker ${marker.id} has invalid text values.`;
  if (typeof marker.color !== 'string' || marker.color.length > 40) return `Marker ${marker.id} has invalid text values.`;
  if (!['marker', 'region', 'cue'].includes(marker.kind)) return `Marker ${marker.id} has invalid text values.`;
  return undefined;
}

function declaredMarkerRangeError(marker: Marker): string | undefined {
  if (!Number.isSafeInteger(marker.tick) || marker.tick < 0 || (marker.endTick !== undefined && (!Number.isSafeInteger(marker.endTick) || marker.endTick <= marker.tick))) return `Marker ${marker.id} has an invalid range.`;
  return undefined;
}

function declaredSectionTextError(section: SongSection): string | undefined {
  if (typeof section.name !== 'string' || section.name.length < 1 || section.name.length > 200) return `Section ${section.id} has invalid text values.`;
  if (typeof section.color !== 'string' || section.color.length > 40) return `Section ${section.id} has invalid text values.`;
  if (section.prompt !== undefined && (typeof section.prompt !== 'string' || section.prompt.length > 10_000)) return `Section ${section.id} has invalid text values.`;
  return undefined;
}

function declaredSectionRangeError(section: SongSection): string | undefined {
  if (!Number.isSafeInteger(section.startTick) || section.startTick < 0 || !Number.isSafeInteger(section.endTick) || section.endTick <= section.startTick) return `Section ${section.id} has an invalid range or energy.`;
  return undefined;
}

function declaredTempoValueError(event: TempoEvent): string | undefined {
  if (!Number.isInteger(event.tick) || event.tick < 0 || !Number.isFinite(event.bpm) || event.bpm < 20 || event.bpm > 400) return `Tempo event ${event.id} has an invalid tick or BPM.`;
  if (!['step', 'linear'].includes(event.curve)) return `Tempo event ${event.id} has an invalid curve.`;
  return undefined;
}

function declaredMeterValueError(event: TimeSignatureEvent): string | undefined {
  if (!Number.isInteger(event.tick) || event.tick < 0 || !Number.isInteger(event.numerator) || event.numerator < 1 || event.numerator > 32 || ![1, 2, 4, 8, 16, 32].includes(event.denominator)) return `Meter event ${event.id} has an invalid tick or signature.`;
  return undefined;
}

function stableUnit(seed: number, key: string): number {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest();
  return digest.readUInt32LE(0) / 0xffffffff;
}

function updateEntity<T extends EntityBase>(entity: T, changes: object, actor: Actor, timestamp: string): void {
  Object.assign(entity, changes);
  touch(entity, actor, timestamp);
}

function trackAcceptsClip(track: Track, clip: Clip): boolean {
  if (clip.kind === 'audio') return track.kind === 'audio';
  return track.kind === 'instrument' || track.kind === 'midi';
}

function assertDeclaredMidiEntityBases(clip: Extract<Clip, { kind: 'midi' }>, operationIndex: number): void {
  for (const note of Object.values(clip.notes)) assertDeclaredEntityBase(note, operationIndex, 'MIDI note');
  for (const event of Object.values(clip.controls)) assertDeclaredEntityBase(event, operationIndex, 'MIDI control');
  for (const event of Object.values(clip.pitchBends)) assertDeclaredEntityBase(event, operationIndex, 'MIDI pitch bend');
}

function assertDeclaredWarpMarkers(clip: Extract<Clip, { kind: 'audio' }>, operationIndex: number): void {
  for (const marker of clip.warpMarkers) assertDeclaredEntityBase(marker, operationIndex, 'Warp marker');
  if (clip.warpMarkers.some((marker) => !Number.isSafeInteger(marker.sourceSample) || marker.sourceSample < 0 || !Number.isSafeInteger(marker.projectTick) || marker.projectTick < 0)) {
    conflict(operationIndex, `Audio clip ${clip.id} has invalid warp timing.`);
  }
}

function declaredAutomationPointError(point: AutomationPoint): string | undefined {
  if (!Number.isSafeInteger(point.tick) || point.tick < 0) return `Automation point ${point.id} has an invalid tick.`;
  if (!Number.isFinite(point.value)) return `Automation point ${point.id} has an invalid value.`;
  if (!['hold', 'linear', 'bezier'].includes(point.curve)) return `Automation point ${point.id} has an invalid curve.`;
  if (point.tension !== undefined && (!Number.isFinite(point.tension) || point.tension < -1 || point.tension > 1)) return `Automation point ${point.id} has an invalid tension.`;
  return undefined;
}

function declaredAutomationLaneError(lane: AutomationLane): string | undefined {
  if (!isDeclaredId(lane.trackId)) return `Automation lane ${lane.id} has an invalid track ID.`;
  const target = lane.target as AutomationLane['target'] | null | undefined;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return `Automation lane ${lane.id} has an invalid target.`;
  if (target.kind === 'track') {
    if (!['gainDb', 'pan'].includes(target.parameter)) return `Automation lane ${lane.id} has an invalid target.`;
  } else if (target.kind === 'device') {
    if (!isDeclaredId(target.deviceId) || typeof target.parameterId !== 'string' || target.parameterId.length < 1 || target.parameterId.length > 500) return `Automation lane ${lane.id} has an invalid target.`;
  } else return `Automation lane ${lane.id} has an invalid target.`;
  if (!lane.points || typeof lane.points !== 'object' || Array.isArray(lane.points)) return `Automation lane ${lane.id} has an invalid point record.`;
  if (typeof lane.armed !== 'boolean' || typeof lane.visible !== 'boolean') return `Automation lane ${lane.id} has invalid state flags.`;
  return undefined;
}

function declaredAutomationIndexError(lane: AutomationLane): string | undefined {
  if (Object.keys(lane.points).some((id) => !isDeclaredId(id))) return `Automation lane ${lane.id} has an invalid point record.`;
  if (!Array.isArray(lane.pointOrder) || lane.pointOrder.some((id) => !isDeclaredId(id))) return `Automation lane ${lane.id} has an invalid point order.`;
  return undefined;
}

function assertDeclaredAutomationPoint(point: AutomationPoint, operationIndex: number): void {
  assertDeclaredEntityBase(point, operationIndex, 'Automation point');
  const pointError = declaredAutomationPointError(point);
  if (pointError) conflict(operationIndex, pointError);
}

function assertDeclaredAutomationLane(lane: AutomationLane, operationIndex: number): void {
  assertDeclaredEntityBase(lane, operationIndex, 'Automation lane');
  const laneError = declaredAutomationLaneError(lane);
  if (laneError) conflict(operationIndex, laneError);
  for (const point of Object.values(lane.points)) assertDeclaredAutomationPoint(point, operationIndex);
  const indexError = declaredAutomationIndexError(lane);
  if (indexError) conflict(operationIndex, indexError);
}

function assertDeclaredTrackDeviceRoutingCleanup(project: AIMuseProject, track: Track, operationIndex: number): void {
  const deviceIds = new Set(track.deviceIds);
  for (const deviceId of deviceIds) {
    const device = project.devices[deviceId];
    if (device) assertDeclaredDevice(device, operationIndex);
  }
  for (const send of Object.values(project.sends)) {
    if (send.sourceTrackId === track.id || send.destinationTrackId === track.id) assertDeclaredEntityBase(send, operationIndex, 'Send');
  }
  for (const route of Object.values(project.sidechains)) {
    if (route.sourceTrackId === track.id || deviceIds.has(route.destinationDeviceId)) assertDeclaredEntityBase(route, operationIndex, 'Sidechain');
  }
}

function deleteClip(project: AIMuseProject, clipId: Id, operationIndex: number): void {
  const clip = project.clips[clipId];
  if (!clip) return;
  assertDeclaredEntityBase(clip, operationIndex, 'Clip');
  if (clip.kind === 'audio') {
    assertDeclaredWarpMarkers(clip, operationIndex);
    assertDeclaredAudioClipSource(project, clip, operationIndex);
  }
  assertDeclaredClipNumeric(clip, operationIndex);
  removeFrom(project.tracks[clip.trackId]?.clipIds ?? [], clipId);
  if (clip.takeLaneId) removeFrom(project.takeLanes[clip.takeLaneId]?.clipIds ?? [], clipId);
  delete project.clips[clipId];
}

function applyOperation(project: AIMuseProject, operation: ProjectOperation, operationIndex: number, transaction: ProjectTransaction, actor: Actor, timestamp: string): void {
  switch (operation.kind) {
    case 'project.rename':
      if (!operation.name.trim() || operation.name.length > 200) conflict(operationIndex, 'Project name must contain 1–200 characters.');
      project.name = operation.name.trim();
      return;
    case 'project.settings.update': {
      const next = { ...project.settings, ...operation.changes };
      const settingsError = declaredProjectSettingsError(next);
      if (settingsError) conflict(operationIndex, settingsError);
      if (next.defaultCrossfadeTicks > 960 * 16) conflict(operationIndex, 'Crossfade is outside its supported range.');
      project.settings = next;
      return;
    }
    case 'tempo.upsert': {
      assertDeclaredEntityBase(operation.event, operationIndex, 'Tempo event');
      const tempoError = declaredTempoValueError(operation.event);
      if (tempoError) conflict(operationIndex, tempoError);
      const existing = project.tempoEvents[operation.event.id];
      if (existing) {
        expectEntity(existing, operationIndex, 'Tempo event', operation.expectedRevision);
        assertDeclaredEntityBase(existing, operationIndex, 'Tempo event');
        project.tempoEvents[existing.id] = { ...normalizeNewEntity(operation.event, actor, timestamp), createdAt: existing.createdAt, createdBy: existing.createdBy, revision: existing.revision + 1 };
      } else {
        project.tempoEvents[operation.event.id] = normalizeNewEntity(operation.event, actor, timestamp);
        project.tempoOrder.push(operation.event.id);
      }
      project.tempoOrder.sort((a, b) => project.tempoEvents[a].tick - project.tempoEvents[b].tick);
      return;
    }
    case 'tempo.delete': {
      const event = expectEntity(project.tempoEvents[operation.eventId], operationIndex, 'Tempo event', operation.expectedRevision);
      assertDeclaredEntityBase(event, operationIndex, 'Tempo event');
      if (event.tick === 0 || project.tempoOrder.length === 1) conflict(operationIndex, 'The project must keep a tempo event at tick zero.');
      delete project.tempoEvents[event.id]; removeFrom(project.tempoOrder, event.id); return;
    }
    case 'meter.upsert': {
      const event = operation.event;
      assertDeclaredEntityBase(event, operationIndex, 'Meter event');
      const meterError = declaredMeterValueError(event);
      if (meterError) conflict(operationIndex, meterError);
      const existing = project.timeSignatureEvents[event.id];
      if (existing) {
        expectEntity(existing, operationIndex, 'Meter event', operation.expectedRevision);
        assertDeclaredEntityBase(existing, operationIndex, 'Meter event');
        project.timeSignatureEvents[event.id] = { ...normalizeNewEntity(event, actor, timestamp), createdAt: existing.createdAt, createdBy: existing.createdBy, revision: existing.revision + 1 };
      } else {
        project.timeSignatureEvents[event.id] = normalizeNewEntity(event, actor, timestamp);
        project.timeSignatureOrder.push(event.id);
      }
      project.timeSignatureOrder.sort((a, b) => project.timeSignatureEvents[a].tick - project.timeSignatureEvents[b].tick);
      return;
    }
    case 'meter.delete': {
      const event = expectEntity(project.timeSignatureEvents[operation.eventId], operationIndex, 'Meter event', operation.expectedRevision);
      assertDeclaredEntityBase(event, operationIndex, 'Meter event');
      if (event.tick === 0 || project.timeSignatureOrder.length === 1) conflict(operationIndex, 'The project must keep a meter event at tick zero.');
      delete project.timeSignatureEvents[event.id]; removeFrom(project.timeSignatureOrder, event.id); return;
    }
    case 'marker.add': {
      assertDeclaredEntityBase(operation.marker, operationIndex, 'Marker');
      if (project.markers[operation.marker.id]) conflict(operationIndex, 'Marker ID already exists.');
      const markerError = declaredMarkerTextError(operation.marker);
      if (markerError) conflict(operationIndex, markerError);
      const rangeError = declaredMarkerRangeError(operation.marker);
      if (rangeError) conflict(operationIndex, rangeError);
      project.markers[operation.marker.id] = normalizeNewEntity(operation.marker, actor, timestamp); insertAt(project.markerOrder, operation.marker.id, operation.index); return;
    }
    case 'marker.update': {
      const marker = expectEntity(project.markers[operation.markerId], operationIndex, 'Marker', operation.expectedRevision);
      assertDeclaredEntityBase(marker, operationIndex, 'Marker');
      const nextMarker = { ...marker, ...operation.changes };
      const markerError = declaredMarkerTextError(nextMarker);
      if (markerError) conflict(operationIndex, markerError);
      const existingRangeError = declaredMarkerRangeError(marker);
      if (existingRangeError) conflict(operationIndex, existingRangeError);
      const nextRangeError = declaredMarkerRangeError(nextMarker);
      if (nextRangeError) conflict(operationIndex, nextRangeError);
      updateEntity(marker, operation.changes, actor, timestamp); return;
    }
    case 'marker.delete': {
      const marker = expectEntity(project.markers[operation.markerId], operationIndex, 'Marker', operation.expectedRevision);
      assertDeclaredEntityBase(marker, operationIndex, 'Marker');
      const rangeError = declaredMarkerRangeError(marker);
      if (rangeError) conflict(operationIndex, rangeError);
      delete project.markers[marker.id]; removeFrom(project.markerOrder, marker.id); return;
    }
    case 'section.add': {
      assertDeclaredEntityBase(operation.section, operationIndex, 'Section');
      if (project.sections[operation.section.id]) conflict(operationIndex, 'Section ID already exists.');
      const sectionError = declaredSectionTextError(operation.section);
      if (sectionError) conflict(operationIndex, sectionError);
      const rangeError = declaredSectionRangeError(operation.section);
      if (rangeError) conflict(operationIndex, rangeError);
      project.sections[operation.section.id] = normalizeNewEntity(operation.section, actor, timestamp); insertAt(project.sectionOrder, operation.section.id, operation.index); return;
    }
    case 'section.update': {
      const section = expectEntity(project.sections[operation.sectionId], operationIndex, 'Section', operation.expectedRevision);
      assertDeclaredEntityBase(section, operationIndex, 'Section');
      const nextSection = { ...section, ...operation.changes };
      const sectionError = declaredSectionTextError(nextSection);
      if (sectionError) conflict(operationIndex, sectionError);
      const existingRangeError = declaredSectionRangeError(section);
      if (existingRangeError) conflict(operationIndex, existingRangeError);
      const nextRangeError = declaredSectionRangeError(nextSection);
      if (nextRangeError) conflict(operationIndex, nextRangeError);
      updateEntity(section, operation.changes, actor, timestamp); return;
    }
    case 'section.delete': {
      const section = expectEntity(project.sections[operation.sectionId], operationIndex, 'Section', operation.expectedRevision);
      assertDeclaredEntityBase(section, operationIndex, 'Section');
      const rangeError = declaredSectionRangeError(section);
      if (rangeError) conflict(operationIndex, rangeError);
      delete project.sections[section.id]; removeFrom(project.sectionOrder, section.id); return;
    }
    case 'lyrics.set':
      if (typeof operation.lyrics !== 'string' || operation.lyrics.length > 200_000) conflict(operationIndex, 'Lyrics must contain at most 200,000 characters.');
      project.lyrics = operation.lyrics;
      return;
    case 'track.add': {
      const track = operation.track;
      assertDeclaredEntityBase(track, operationIndex, 'Track');
      if (project.tracks[track.id]) conflict(operationIndex, 'Track ID already exists.');
      if (track.kind === 'master' && Object.values(project.tracks).some((value) => value.kind === 'master')) conflict(operationIndex, 'A project can contain only one master track.');
      if (operation.parentId) {
        const parent = project.tracks[operation.parentId];
        if (!parent || parent.kind !== 'folder') conflict(operationIndex, 'Parent track must be a folder.');
      }
      const trackError = declaredTrackMutableError(track);
      if (trackError) conflict(operationIndex, trackError);
      assertDeclaredTrackKind(track, operationIndex);
      const next = normalizeNewEntity({ ...track, parentId: operation.parentId, clipIds: [], deviceIds: [], automationLaneIds: [], childTrackIds: [] }, actor, timestamp);
      project.tracks[next.id] = next;
      if (operation.parentId) insertAt(project.tracks[operation.parentId].childTrackIds, next.id, operation.index);
      else insertAt(project.trackOrder, next.id, operation.index);
      return;
    }
    case 'track.update': {
      const track = expectEntity(project.tracks[operation.trackId], operationIndex, 'Track', operation.expectedRevision);
      assertDeclaredEntityBase(track, operationIndex, 'Track');
      const trackError = declaredTrackMutableError({ ...track, ...operation.changes });
      if (trackError) conflict(operationIndex, trackError);
      assertDeclaredTrackKind(track, operationIndex);
      updateEntity(track, operation.changes, actor, timestamp); return;
    }
    case 'track.move': {
      const track = expectEntity(project.tracks[operation.trackId], operationIndex, 'Track', operation.expectedRevision);
      assertDeclaredEntityBase(track, operationIndex, 'Track');
      if (track.kind === 'master' && operation.parentId) conflict(operationIndex, 'Master cannot be nested.');
      if (operation.parentId === track.id) conflict(operationIndex, 'A track cannot parent itself.');
      if (operation.parentId) {
        const parent = project.tracks[operation.parentId];
        if (!parent || parent.kind !== 'folder') conflict(operationIndex, 'Parent track must be a folder.');
        let cursor: Track | undefined = parent;
        while (cursor?.parentId) { if (cursor.parentId === track.id) conflict(operationIndex, 'Folder move would create a cycle.'); cursor = project.tracks[cursor.parentId]; }
      }
      assertDeclaredTrackKind(track, operationIndex);
      if (track.parentId) removeFrom(project.tracks[track.parentId]?.childTrackIds ?? [], track.id); else removeFrom(project.trackOrder, track.id);
      track.parentId = operation.parentId;
      if (operation.parentId) insertAt(project.tracks[operation.parentId].childTrackIds, track.id, operation.index); else insertAt(project.trackOrder, track.id, operation.index);
      touch(track, actor, timestamp); return;
    }
    case 'track.delete': {
      const track = expectEntity(project.tracks[operation.trackId], operationIndex, 'Track', operation.expectedRevision);
      assertDeclaredEntityBase(track, operationIndex, 'Track');
      if (track.kind === 'master') conflict(operationIndex, 'The master track cannot be deleted.');
      const referenced = track.clipIds.length + track.deviceIds.length + track.automationLaneIds.length + track.childTrackIds.length;
      if (referenced && !operation.cascade) conflict(operationIndex, 'Track is not empty; submit an explicit cascade delete.');
      assertDeclaredTrackDeviceRoutingCleanup(project, track, operationIndex);
      for (const laneId of track.automationLaneIds) {
        const lane = project.automationLanes[laneId];
        if (lane) assertDeclaredAutomationLane(lane, operationIndex);
      }
      assertDeclaredTrackKind(track, operationIndex);
      const descendants = [...track.childTrackIds];
      for (const childId of descendants) applyOperation(project, { kind: 'track.delete', trackId: childId, cascade: true }, operationIndex, transaction, actor, timestamp);
      for (const clipId of [...track.clipIds]) deleteClip(project, clipId, operationIndex);
      for (const deviceId of [...track.deviceIds]) { delete project.devices[deviceId]; for (const route of Object.values(project.sidechains)) if (route.destinationDeviceId === deviceId) delete project.sidechains[route.id]; }
      for (const laneId of [...track.automationLaneIds]) delete project.automationLanes[laneId];
      for (const [id, send] of Object.entries(project.sends)) if (send.sourceTrackId === track.id || send.destinationTrackId === track.id) delete project.sends[id];
      for (const [id, route] of Object.entries(project.sidechains)) if (route.sourceTrackId === track.id) delete project.sidechains[id];
      if (track.parentId) removeFrom(project.tracks[track.parentId]?.childTrackIds ?? [], track.id); else removeFrom(project.trackOrder, track.id);
      delete project.tracks[track.id]; return;
    }
    case 'clip.add': {
      const clip = operation.clip;
      assertDeclaredEntityBase(clip, operationIndex, 'Clip');
      if (project.clips[clip.id]) conflict(operationIndex, 'Clip ID already exists.');
      const track = project.tracks[clip.trackId];
      if (!track || !trackAcceptsClip(track, clip)) conflict(operationIndex, 'Clip type is incompatible with its track.');
      const clipError = declaredClipMutableError(clip);
      if (clipError) conflict(operationIndex, clipError);
      assertFinite(clip.startTick, operationIndex, 'Clip start', 0); assertFinite(clip.durationTicks, operationIndex, 'Clip duration', 1);
      if (clip.kind === 'audio') {
        assertDeclaredWarpMarkers(clip, operationIndex);
        assertDeclaredAudioClipSource(project, clip, operationIndex);
      } else assertDeclaredMidiEntityBases(clip, operationIndex);
      assertDeclaredClipNumeric(clip, operationIndex);
      const next = normalizeNewEntity(clip, actor, timestamp);
      if (next.kind === 'midi') {
        next.notes = Object.fromEntries(Object.values(next.notes).map((note) => [note.id, normalizeNewEntity(note, actor, timestamp)]));
        next.controls = Object.fromEntries(Object.values(next.controls).map((event) => [event.id, normalizeNewEntity(event, actor, timestamp)]));
        next.pitchBends = Object.fromEntries(Object.values(next.pitchBends).map((event) => [event.id, normalizeNewEntity(event, actor, timestamp)]));
      }
      project.clips[next.id] = next; insertAt(track.clipIds, next.id, operation.index); return;
    }
    case 'clip.update': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'Clip', operation.expectedRevision);
      assertDeclaredEntityBase(clip, operationIndex, 'Clip');
      const changes = operation.changes as Record<string, unknown>;
      if (changes.startTick !== undefined) assertFinite(Number(changes.startTick), operationIndex, 'Clip start', 0);
      if (changes.durationTicks !== undefined) assertFinite(Number(changes.durationTicks), operationIndex, 'Clip duration', 1);
      if (clip.kind === 'audio') assertDeclaredWarpMarkers(clip, operationIndex);
      const nextClip = { ...clip, ...changes } as Clip;
      const clipError = declaredClipMutableError(nextClip);
      if (clipError) conflict(operationIndex, clipError);
      if (nextClip.kind === 'audio') assertDeclaredWarpMarkers(nextClip, operationIndex);
      if (clip.kind === 'audio') assertDeclaredAudioClipSource(project, clip, operationIndex);
      if (nextClip.kind === 'audio') assertDeclaredAudioClipSource(project, nextClip, operationIndex);
      assertDeclaredClipNumeric(clip, operationIndex);
      assertDeclaredClipNumeric(nextClip, operationIndex);
      updateEntity(clip, changes, actor, timestamp); return;
    }
    case 'clip.move': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'Clip', operation.expectedRevision);
      assertDeclaredEntityBase(clip, operationIndex, 'Clip');
      if (clip.kind === 'audio') assertDeclaredWarpMarkers(clip, operationIndex);
      const target = project.tracks[operation.trackId];
      if (!target || !trackAcceptsClip(target, clip)) conflict(operationIndex, 'Target track is incompatible with the clip.');
      assertFinite(operation.startTick, operationIndex, 'Clip start', 0);
      if (clip.kind === 'audio') assertDeclaredAudioClipSource(project, clip, operationIndex);
      assertDeclaredClipNumeric(clip, operationIndex);
      assertDeclaredClipNumeric({ ...clip, startTick: operation.startTick }, operationIndex);
      removeFrom(project.tracks[clip.trackId].clipIds, clip.id); clip.trackId = target.id; clip.startTick = operation.startTick; insertAt(target.clipIds, clip.id, operation.index); touch(clip, actor, timestamp); return;
    }
    case 'clip.trim': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'Clip', operation.expectedRevision);
      assertDeclaredEntityBase(clip, operationIndex, 'Clip');
      if (clip.kind === 'audio') assertDeclaredWarpMarkers(clip, operationIndex);
      assertFinite(operation.startTick, operationIndex, 'Clip start', 0); assertFinite(operation.durationTicks, operationIndex, 'Clip duration', 1);
      if (clip.kind === 'audio') {
        assertDeclaredAudioClipSource(project, clip, operationIndex);
        assertDeclaredAudioClipSource(project, {
          ...clip,
          sourceStartSample: operation.sourceStartSample ?? clip.sourceStartSample,
          sourceDurationSamples: operation.sourceDurationSamples ?? clip.sourceDurationSamples,
        }, operationIndex);
      }
      assertDeclaredClipNumeric(clip, operationIndex);
      assertDeclaredClipNumeric({ ...clip, startTick: operation.startTick, durationTicks: operation.durationTicks }, operationIndex);
      clip.startTick = operation.startTick; clip.durationTicks = operation.durationTicks;
      if (clip.kind === 'audio') {
        if (operation.sourceStartSample !== undefined) clip.sourceStartSample = Math.max(0, Math.round(operation.sourceStartSample));
        if (operation.sourceDurationSamples !== undefined) clip.sourceDurationSamples = Math.max(1, Math.round(operation.sourceDurationSamples));
      }
      touch(clip, actor, timestamp); return;
    }
    case 'clip.split': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'Clip', operation.expectedRevision);
      assertDeclaredEntityBase(clip, operationIndex, 'Clip');
      assertDeclaredEntityBase(operation.rightClip, operationIndex, 'Clip');
      if (clip.kind === 'audio') assertDeclaredWarpMarkers(clip, operationIndex);
      if (operation.rightClip.kind === 'audio') assertDeclaredWarpMarkers(operation.rightClip, operationIndex);
      if (operation.tick <= clip.startTick || operation.tick >= clip.startTick + clip.durationTicks) conflict(operationIndex, 'Split tick must be inside the clip.');
      if (project.clips[operation.rightClip.id]) conflict(operationIndex, 'Right clip ID already exists.');
      if (operation.rightClip.kind !== clip.kind) conflict(operationIndex, 'Split clips must have the same kind.');
      if (clip.kind === 'audio') assertDeclaredAudioClipSource(project, clip, operationIndex);
      if (operation.rightClip.kind === 'audio') assertDeclaredAudioClipSource(project, operation.rightClip, operationIndex);
      const leftDuration = operation.tick - clip.startTick; const rightDuration = clip.durationTicks - leftDuration;
      assertDeclaredClipNumeric(clip, operationIndex);
      assertDeclaredClipNumeric(operation.rightClip, operationIndex);
      assertDeclaredClipNumeric({ ...clip, durationTicks: leftDuration }, operationIndex);
      assertDeclaredClipNumeric({ ...operation.rightClip, trackId: clip.trackId, startTick: operation.tick, durationTicks: rightDuration }, operationIndex);
      clip.durationTicks = leftDuration; touch(clip, actor, timestamp);
      const right = normalizeNewEntity({ ...operation.rightClip, trackId: clip.trackId, startTick: operation.tick, durationTicks: rightDuration }, actor, timestamp);
      if (clip.kind === 'midi' && right.kind === 'midi') {
        const leftNotes: Record<Id, MidiNote> = {}; const rightNotes: Record<Id, MidiNote> = {};
        for (const note of Object.values(clip.notes)) {
          if (note.startTick < leftDuration) leftNotes[note.id] = note;
          else rightNotes[note.id] = { ...note, startTick: note.startTick - leftDuration };
        }
        const originalOrder = [...clip.noteOrder];
        clip.notes = leftNotes; clip.noteOrder = originalOrder.filter((id) => leftNotes[id]); right.notes = rightNotes; right.noteOrder = originalOrder.filter((id) => rightNotes[id]);
        const leftControls: Record<Id, MidiControlEvent> = {}; const rightControls: Record<Id, MidiControlEvent> = {};
        for (const event of Object.values(clip.controls)) {
          if (event.tick < leftDuration) leftControls[event.id] = event;
          else rightControls[event.id] = { ...event, tick: event.tick - leftDuration };
        }
        const originalControlOrder = [...clip.controlOrder];
        clip.controls = leftControls; clip.controlOrder = originalControlOrder.filter((id) => leftControls[id]); right.controls = rightControls; right.controlOrder = originalControlOrder.filter((id) => rightControls[id]);
        const leftBends: Record<Id, MidiPitchBendEvent> = {}; const rightBends: Record<Id, MidiPitchBendEvent> = {};
        for (const event of Object.values(clip.pitchBends)) {
          if (event.tick < leftDuration) leftBends[event.id] = event;
          else rightBends[event.id] = { ...event, tick: event.tick - leftDuration };
        }
        const originalBendOrder = [...clip.pitchBendOrder];
        clip.pitchBends = leftBends; clip.pitchBendOrder = originalBendOrder.filter((id) => leftBends[id]); right.pitchBends = rightBends; right.pitchBendOrder = originalBendOrder.filter((id) => rightBends[id]);
      }
      project.clips[right.id] = right; const track = project.tracks[clip.trackId]; insertAt(track.clipIds, right.id, track.clipIds.indexOf(clip.id) + 1); return;
    }
    case 'clip.delete': expectEntity(project.clips[operation.clipId], operationIndex, 'Clip', operation.expectedRevision); deleteClip(project, operation.clipId, operationIndex); return;
    case 'take-lane.add': {
      assertDeclaredEntityBase(operation.lane, operationIndex, 'Take lane');
      if (project.takeLanes[operation.lane.id] || !project.tracks[operation.lane.trackId]) conflict(operationIndex, 'Invalid take lane.');
      const laneError = declaredTakeLaneMutableError(operation.lane);
      if (laneError) conflict(operationIndex, laneError);
      project.takeLanes[operation.lane.id] = normalizeNewEntity(operation.lane, actor, timestamp); return;
    }
    case 'take-lane.update': {
      const lane = expectEntity(project.takeLanes[operation.laneId], operationIndex, 'Take lane', operation.expectedRevision);
      assertDeclaredEntityBase(lane, operationIndex, 'Take lane');
      const laneError = declaredTakeLaneMutableError({ ...lane, ...operation.changes });
      if (laneError) conflict(operationIndex, laneError);
      updateEntity(lane, operation.changes, actor, timestamp); return;
    }
    case 'take-lane.delete': {
      const lane = expectEntity(project.takeLanes[operation.laneId], operationIndex, 'Take lane', operation.expectedRevision);
      assertDeclaredEntityBase(lane, operationIndex, 'Take lane');
      const relatedSegments = Object.entries(project.compSegments).filter(([, segment]) => segment.takeLaneId === lane.id);
      for (const [, segment] of relatedSegments) assertDeclaredEntityBase(segment, operationIndex, 'Comp segment');
      for (const [, segment] of relatedSegments) {
        const segmentError = declaredCompSegmentError(project, segment);
        if (segmentError) conflict(operationIndex, segmentError);
      }
      for (const clipId of lane.clipIds) if (project.clips[clipId]) project.clips[clipId].takeLaneId = undefined;
      delete project.takeLanes[lane.id]; for (const [id] of relatedSegments) delete project.compSegments[id]; return;
    }
    case 'comp-segment.upsert': {
      assertDeclaredEntityBase(operation.segment, operationIndex, 'Comp segment');
      const segmentError = declaredCompSegmentError(project, operation.segment);
      if (segmentError) conflict(operationIndex, 'Comp segment references an invalid track, take lane, or range.');
      const existing = project.compSegments[operation.segment.id];
      if (existing) {
        expectEntity(existing, operationIndex, 'Comp segment', operation.expectedRevision);
        assertDeclaredEntityBase(existing, operationIndex, 'Comp segment');
        const existingError = declaredCompSegmentError(project, existing);
        if (existingError) conflict(operationIndex, existingError);
        project.compSegments[existing.id] = { ...normalizeNewEntity(operation.segment, actor, timestamp), createdAt: existing.createdAt, createdBy: existing.createdBy, revision: existing.revision + 1 };
      }
      else project.compSegments[operation.segment.id] = normalizeNewEntity(operation.segment, actor, timestamp);
      return;
    }
    case 'comp-segment.delete': {
      const segment = expectEntity(project.compSegments[operation.segmentId], operationIndex, 'Comp segment', operation.expectedRevision);
      assertDeclaredEntityBase(segment, operationIndex, 'Comp segment');
      const segmentError = declaredCompSegmentError(project, segment);
      if (segmentError) conflict(operationIndex, segmentError);
      delete project.compSegments[segment.id]; return;
    }
    case 'midi.note.add': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Invalid MIDI note target.');
      assertDeclaredEntityBase(operation.note, operationIndex, 'MIDI note');
      if (clip.notes[operation.note.id]) conflict(operationIndex, 'Invalid MIDI note target.');
      clip.notes[operation.note.id] = normalizeNewEntity(operation.note, actor, timestamp); clip.noteOrder.push(operation.note.id); touch(clip, actor, timestamp); return;
    }
    case 'midi.note.update': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.');
      const note = expectEntity(clip.notes[operation.noteId], operationIndex, 'MIDI note'); assertDeclaredEntityBase(note, operationIndex, 'MIDI note'); updateEntity(note, operation.changes, actor, timestamp); touch(clip, actor, timestamp); return;
    }
    case 'midi.note.delete': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.'); const note = expectEntity(clip.notes[operation.noteId], operationIndex, 'MIDI note'); assertDeclaredEntityBase(note, operationIndex, 'MIDI note'); delete clip.notes[operation.noteId]; removeFrom(clip.noteOrder, operation.noteId); touch(clip, actor, timestamp); return;
    }
    case 'midi.control.add': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Invalid MIDI control target.'); assertDeclaredEntityBase(operation.event, operationIndex, 'MIDI control'); if (clip.controls[operation.event.id]) conflict(operationIndex, 'Invalid MIDI control target.'); clip.controls[operation.event.id] = normalizeNewEntity(operation.event, actor, timestamp); clip.controlOrder.push(operation.event.id); touch(clip, actor, timestamp); return;
    }
    case 'midi.control.delete': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.'); const event = expectEntity(clip.controls[operation.eventId], operationIndex, 'MIDI control'); assertDeclaredEntityBase(event, operationIndex, 'MIDI control'); delete clip.controls[operation.eventId]; removeFrom(clip.controlOrder, operation.eventId); touch(clip, actor, timestamp); return;
    }
    case 'midi.pitch-bend.add': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Invalid MIDI pitch-bend target.'); assertDeclaredEntityBase(operation.event, operationIndex, 'MIDI pitch bend'); if (clip.pitchBends[operation.event.id]) conflict(operationIndex, 'Invalid MIDI pitch-bend target.'); clip.pitchBends[operation.event.id] = normalizeNewEntity(operation.event, actor, timestamp); clip.pitchBendOrder.push(operation.event.id); touch(clip, actor, timestamp); return;
    }
    case 'midi.pitch-bend.update': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.'); const event = expectEntity(clip.pitchBends[operation.eventId], operationIndex, 'MIDI pitch bend'); assertDeclaredEntityBase(event, operationIndex, 'MIDI pitch bend'); updateEntity(event, operation.changes, actor, timestamp); touch(clip, actor, timestamp); return;
    }
    case 'midi.pitch-bend.delete': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.'); const event = expectEntity(clip.pitchBends[operation.eventId], operationIndex, 'MIDI pitch bend'); assertDeclaredEntityBase(event, operationIndex, 'MIDI pitch bend'); delete clip.pitchBends[operation.eventId]; removeFrom(clip.pitchBendOrder, operation.eventId); touch(clip, actor, timestamp); return;
    }
    case 'midi.semantic': {
      const clip = expectEntity(project.clips[operation.clipId], operationIndex, 'MIDI clip', operation.expectedRevision);
      if (clip.kind !== 'midi') conflict(operationIndex, 'Target is not a MIDI clip.');
      const ids = operation.noteIds?.length ? operation.noteIds : clip.noteOrder;
      const notes = ids.map((id) => clip.notes[id]).filter(Boolean);
      for (const note of notes) assertDeclaredEntityBase(note, operationIndex, 'MIDI note');
      if (operation.action === 'quantize') {
        const grid = operation.gridTicks ?? 240; const strength = operation.strength ?? 1; assertFinite(grid, operationIndex, 'Quantize grid', 1); assertFinite(strength, operationIndex, 'Quantize strength', 0, 1);
        for (const note of notes) { note.startTick = Math.max(0, Math.round(note.startTick + (Math.round(note.startTick / grid) * grid - note.startTick) * strength)); touch(note, actor, timestamp); }
      } else if (operation.action === 'humanize') {
        const seed = operation.seed ?? 0; const timing = Math.max(0, operation.timingTicks ?? 12); const velocity = Math.max(0, operation.velocityAmount ?? 0.04);
        for (const note of notes) { note.startTick = Math.max(0, Math.round(note.startTick + (stableUnit(seed, `${note.id}:t`) * 2 - 1) * timing)); note.velocity = Math.max(0, Math.min(1, note.velocity + (stableUnit(seed, `${note.id}:v`) * 2 - 1) * velocity)); touch(note, actor, timestamp); }
      } else if (operation.action === 'transpose') {
        const semitones = Math.round(operation.semitones ?? 0); for (const note of notes) { note.pitch = Math.max(0, Math.min(127, note.pitch + semitones)); touch(note, actor, timestamp); }
      } else if (operation.action === 'legato') {
        const gap = Math.round(operation.gapTicks ?? 0); const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
        for (let index = 0; index < sorted.length - 1; index += 1) { sorted[index].durationTicks = Math.max(1, sorted[index + 1].startTick - sorted[index].startTick - gap); touch(sorted[index], actor, timestamp); }
      } else if (operation.action === 'duplicate') {
        const offset = Math.round(operation.offsetTicks ?? clip.durationTicks); const additions: MidiNote[] = [];
        for (const note of notes) { const id = `note_${createHash('sha256').update(`${transaction.id}:${operationIndex}:${note.id}`).digest('hex').slice(0, 24)}`; additions.push(normalizeNewEntity({ ...note, id, startTick: note.startTick + offset }, actor, timestamp)); }
        for (const note of additions) { clip.notes[note.id] = note; clip.noteOrder.push(note.id); }
      } else {
        const step = Math.max(1, Math.round(operation.stepTicks ?? 120)); const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.startTick - b.startTick); const start = Math.min(...sorted.map((note) => note.startTick));
        sorted.forEach((note, index) => { note.startTick = start + index * step; note.durationTicks = Math.min(note.durationTicks, step); touch(note, actor, timestamp); });
      }
      touch(clip, actor, timestamp); return;
    }
    case 'automation.lane.add': {
      const lane = operation.lane;
      assertDeclaredAutomationLane(lane, operationIndex);
      const track = project.tracks[lane.trackId]; if (!track || project.automationLanes[lane.id]) conflict(operationIndex, 'Invalid automation lane.');
      project.automationLanes[lane.id] = normalizeNewEntity({ ...lane, points: Object.fromEntries(Object.values(lane.points).map((point) => [point.id, normalizeNewEntity(point, actor, timestamp)])) }, actor, timestamp); track.automationLaneIds.push(lane.id); return;
    }
    case 'automation.lane.update': { const lane = expectEntity(project.automationLanes[operation.laneId], operationIndex, 'Automation lane', operation.expectedRevision); assertDeclaredAutomationLane({ ...lane, ...operation.changes }, operationIndex); updateEntity(lane, operation.changes, actor, timestamp); return; }
    case 'automation.lane.delete': { const lane = expectEntity(project.automationLanes[operation.laneId], operationIndex, 'Automation lane', operation.expectedRevision); assertDeclaredAutomationLane(lane, operationIndex); removeFrom(project.tracks[lane.trackId]?.automationLaneIds ?? [], lane.id); delete project.automationLanes[lane.id]; return; }
    case 'automation.point.upsert': {
      const lane = expectEntity(project.automationLanes[operation.laneId], operationIndex, 'Automation lane', operation.expectedRevision);
      assertDeclaredAutomationLane(lane, operationIndex);
      assertDeclaredAutomationPoint(operation.point, operationIndex);
      const existing = lane.points[operation.point.id];
      if (existing) lane.points[existing.id] = { ...normalizeNewEntity(operation.point, actor, timestamp), revision: existing.revision + 1 }; else { lane.points[operation.point.id] = normalizeNewEntity(operation.point, actor, timestamp); lane.pointOrder.push(operation.point.id); }
      lane.pointOrder.sort((a, b) => lane.points[a].tick - lane.points[b].tick); touch(lane, actor, timestamp); return;
    }
    case 'automation.point.delete': { const lane = expectEntity(project.automationLanes[operation.laneId], operationIndex, 'Automation lane', operation.expectedRevision); assertDeclaredAutomationLane(lane, operationIndex); expectEntity(lane.points[operation.pointId], operationIndex, 'Automation point'); delete lane.points[operation.pointId]; removeFrom(lane.pointOrder, operation.pointId); touch(lane, actor, timestamp); return; }
    case 'device.add': {
      const device = operation.device;
      assertDeclaredDevice(device, operationIndex);
      const track = project.tracks[device.trackId]; if (!track || ['folder', 'midi'].includes(track.kind) || project.devices[device.id]) conflict(operationIndex, 'Invalid device target.');
      project.devices[device.id] = normalizeNewEntity(device, actor, timestamp); insertAt(track.deviceIds, device.id, operation.index); return;
    }
    case 'device.update': {
      const device = expectEntity(project.devices[operation.deviceId], operationIndex, 'Device', operation.expectedRevision);
      assertDeclaredDevice({ ...device, ...operation.changes }, operationIndex);
      updateEntity(device, operation.changes, actor, timestamp); return;
    }
    case 'device.move': {
      const device = expectEntity(project.devices[operation.deviceId], operationIndex, 'Device', operation.expectedRevision); assertDeclaredDevice(device, operationIndex); const track = project.tracks[operation.trackId]; if (!track || ['folder', 'midi'].includes(track.kind)) conflict(operationIndex, 'Invalid device target.');
      removeFrom(project.tracks[device.trackId].deviceIds, device.id); device.trackId = track.id; insertAt(track.deviceIds, device.id, operation.index); touch(device, actor, timestamp); return;
    }
    case 'device.parameter.set': {
      const device = expectEntity(project.devices[operation.deviceId], operationIndex, 'Device', operation.expectedRevision); assertDeclaredDevice(device, operationIndex); const parameter = device.parameters[operation.parameterId]; if (!parameter) conflict(operationIndex, 'Device parameter does not exist.');
      const parameterError = declaredDeviceParameterError(operation.parameterId, parameter, device.id);
      if (parameterError) conflict(operationIndex, parameterError);
      assertFinite(operation.value, operationIndex, 'Parameter value', parameter.min, parameter.max); parameter.value = operation.value; touch(device, actor, timestamp); return;
    }
    case 'device.delete': {
      const device = expectEntity(project.devices[operation.deviceId], operationIndex, 'Device', operation.expectedRevision);
      assertDeclaredDevice(device, operationIndex);
      const relatedLanes = Object.values(project.automationLanes).filter((lane) => lane.target.kind === 'device' && lane.target.deviceId === device.id);
      const relatedRoutes = Object.values(project.sidechains).filter((route) => route.destinationDeviceId === device.id);
      for (const lane of relatedLanes) assertDeclaredAutomationLane(lane, operationIndex);
      for (const route of relatedRoutes) assertDeclaredEntityBase(route, operationIndex, 'Sidechain');
      removeFrom(project.tracks[device.trackId]?.deviceIds ?? [], device.id); delete project.devices[device.id];
      for (const route of relatedRoutes) delete project.sidechains[route.id];
      for (const lane of relatedLanes) { removeFrom(project.tracks[lane.trackId].automationLaneIds, lane.id); delete project.automationLanes[lane.id]; }
      return;
    }
    case 'send.upsert': {
      const send = operation.send;
      assertDeclaredEntityBase(send, operationIndex, 'Send');
      if (!project.tracks[send.sourceTrackId] || !project.tracks[send.destinationTrackId]) conflict(operationIndex, 'Send references a missing track.');
      const sendError = declaredSendValueError(send);
      if (sendError) conflict(operationIndex, sendError);
      const existing = project.sends[send.id];
      if (existing) { expectEntity(existing, operationIndex, 'Send', operation.expectedRevision); assertDeclaredEntityBase(existing, operationIndex, 'Send'); project.sends[existing.id] = { ...normalizeNewEntity(send, actor, timestamp), createdAt: existing.createdAt, createdBy: existing.createdBy, revision: existing.revision + 1 }; } else project.sends[send.id] = normalizeNewEntity(send, actor, timestamp); return;
    }
    case 'send.delete': { const send = expectEntity(project.sends[operation.sendId], operationIndex, 'Send', operation.expectedRevision); assertDeclaredEntityBase(send, operationIndex, 'Send'); delete project.sends[send.id]; return; }
    case 'sidechain.upsert': {
      const route = operation.route;
      assertDeclaredEntityBase(route, operationIndex, 'Sidechain');
      if (!project.tracks[route.sourceTrackId] || !project.devices[route.destinationDeviceId]) conflict(operationIndex, 'Sidechain references a missing source or device.');
      const routeError = declaredSidechainValueError(route);
      if (routeError) conflict(operationIndex, routeError);
      const existing = project.sidechains[route.id];
      if (existing) { expectEntity(existing, operationIndex, 'Sidechain', operation.expectedRevision); assertDeclaredEntityBase(existing, operationIndex, 'Sidechain'); project.sidechains[existing.id] = { ...normalizeNewEntity(route, actor, timestamp), createdAt: existing.createdAt, createdBy: existing.createdBy, revision: existing.revision + 1 }; } else project.sidechains[route.id] = normalizeNewEntity(route, actor, timestamp); return;
    }
    case 'sidechain.delete': { const route = expectEntity(project.sidechains[operation.routeId], operationIndex, 'Sidechain', operation.expectedRevision); assertDeclaredEntityBase(route, operationIndex, 'Sidechain'); delete project.sidechains[route.id]; return; }
    case 'asset.add': {
      const asset = operation.asset;
      assertDeclaredEntityBase(asset, operationIndex, 'Media asset');
      if (project.assets[asset.id]) conflict(operationIndex, 'Asset ID already exists.');
      const assetError = declaredMediaAssetError(asset);
      if (assetError) conflict(operationIndex, assetError);
      project.assets[asset.id] = normalizeNewEntity(asset, actor, timestamp); return;
    }
    case 'asset.delete': {
      const asset = expectEntity(project.assets[operation.assetId], operationIndex, 'Asset', operation.expectedRevision);
      assertDeclaredEntityBase(asset, operationIndex, 'Media asset');
      if (Object.values(project.clips).some((clip) => clip.kind === 'audio' && clip.assetId === asset.id) || Object.values(project.devices).some((device) => device.stateAssetId === asset.id) || Object.values(project.checkpoints).some((checkpoint) => checkpoint.snapshotAssetId === asset.id) || Object.values(project.provenance).some((entry) => entry.assetId === asset.id || entry.referenceAssetIds.includes(asset.id)) || Object.values(project.variants).some((variant) => variant.snapshotAssetId === asset.id)) conflict(operationIndex, 'Asset is still referenced.');
      delete project.assets[asset.id]; return;
    }
    case 'provenance.register': {
      const value = operation.provenance;
      assertDeclaredEntityBase(value, operationIndex, 'Generation provenance');
      const provenanceError = declaredProvenanceError(value);
      if (provenanceError) conflict(operationIndex, provenanceError);
      if (project.provenance[value.id] || !project.assets[value.assetId] || value.referenceAssetIds.some((id) => !project.assets[id])) conflict(operationIndex, 'Generation provenance references invalid media.');
      project.provenance[value.id] = normalizeNewEntity(value, actor, timestamp); return;
    }
    case 'provenance.update': {
      const value = expectEntity(project.provenance[operation.provenanceId], operationIndex, 'Generation provenance', operation.expectedRevision);
      assertDeclaredEntityBase(value, operationIndex, 'Generation provenance');
      const provenanceError = declaredProvenanceError({ ...value, ...operation.changes });
      if (provenanceError) conflict(operationIndex, provenanceError);
      updateEntity(value, operation.changes, actor, timestamp); return;
    }
    case 'sfx-deliverable.add': {
      const value = operation.deliverable;
      assertDeclaredEntityBase(value, operationIndex, 'SFX deliverable');
      if (project.sfxDeliverables[value.id]) conflict(operationIndex, 'Deliverable ID already exists.');
      project.sfxDeliverables[value.id] = normalizeNewEntity(value, actor, timestamp); return;
    }
    case 'sfx-deliverable.update': {
      const value = expectEntity(project.sfxDeliverables[operation.deliverableId], operationIndex, 'SFX deliverable', operation.expectedRevision);
      assertDeclaredEntityBase(value, operationIndex, 'SFX deliverable');
      updateEntity(value, operation.changes, actor, timestamp); return;
    }
    case 'sfx-deliverable.delete': {
      const value = expectEntity(project.sfxDeliverables[operation.deliverableId], operationIndex, 'SFX deliverable', operation.expectedRevision);
      assertDeclaredEntityBase(value, operationIndex, 'SFX deliverable');
      delete project.sfxDeliverables[value.id]; return;
    }
    case 'checkpoint.register': {
      const value = operation.checkpoint;
      assertDeclaredEntityBase(value, operationIndex, 'Checkpoint');
      if (project.checkpoints[value.id]) conflict(operationIndex, 'Invalid checkpoint.');
      const checkpointError = declaredCheckpointError(value);
      if (checkpointError) conflict(operationIndex, checkpointError);
      if (!project.assets[value.snapshotAssetId]) conflict(operationIndex, 'Invalid checkpoint.');
      project.checkpoints[value.id] = normalizeNewEntity(value, actor, timestamp); return;
    }
    case 'checkpoint.delete': { const value = expectEntity(project.checkpoints[operation.checkpointId], operationIndex, 'Checkpoint', operation.expectedRevision); assertDeclaredEntityBase(value, operationIndex, 'Checkpoint'); if (Object.values(project.variants).some((variant) => variant.baseCheckpointId === value.id && variant.status === 'active')) conflict(operationIndex, 'Checkpoint has an active variant.'); delete project.checkpoints[value.id]; return; }
    case 'variant.register': {
      const value = operation.variant;
      assertDeclaredEntityBase(value, operationIndex, 'Variant');
      if (project.variants[value.id]) conflict(operationIndex, 'Invalid variant.');
      const variantError = declaredVariantMutableError(value);
      if (variantError) conflict(operationIndex, variantError);
      if (!project.checkpoints[value.baseCheckpointId] || (value.snapshotAssetId && !project.assets[value.snapshotAssetId])) conflict(operationIndex, 'Invalid variant.');
      project.variants[value.id] = normalizeNewEntity(value, actor, timestamp); return;
    }
    case 'variant.update': {
      const value = expectEntity(project.variants[operation.variantId], operationIndex, 'Variant', operation.expectedRevision);
      assertDeclaredEntityBase(value, operationIndex, 'Variant');
      const variantError = declaredVariantMutableError({ ...value, ...operation.changes });
      if (variantError) conflict(operationIndex, variantError);
      if (operation.changes.snapshotAssetId && !project.assets[operation.changes.snapshotAssetId]) conflict(operationIndex, 'Variant snapshot media does not exist.');
      updateEntity(value, operation.changes, actor, timestamp); return;
    }
  }
}

export function validateProjectIntegrity(project: AIMuseProject): void {
  const rootError = declaredProjectRootError(project);
  if (rootError) throw new Error(rootError);
  if (project.format !== 'AIMuse' || project.schemaVersion !== 1) throw new Error('Unsupported AIMuse project schema.');
  if (typeof project.name !== 'string' || project.name.length < 1 || project.name.length > 200) throw new Error('Project name must contain 1–200 characters.');
  if (!['song', 'sfx'].includes(project.kind)) throw new Error('Unsupported project kind.');
  const settingsError = declaredProjectSettingsError(project.settings);
  if (settingsError) throw new Error(settingsError);
  if (typeof project.lyrics !== 'string' || project.lyrics.length > 200_000) throw new Error('Lyrics must contain at most 200,000 characters.');
  if (!Array.isArray(project.activity) || project.activity.length > MAX_STORED_ACTIVITY_ENTRIES) throw new Error('Activity ledger exceeds its stored compatibility limit.');
  for (const entry of project.activity) {
    const activityError = declaredActivityError(entry);
    if (activityError) throw new Error(activityError);
  }
  const validateCompleteOrder = <T extends EntityBase>(order: Id[], values: Record<Id, T>, label: string): void => {
    const orderedIds = new Set(order);
    if (orderedIds.size !== order.length || order.some((id) => !values[id]) || Object.keys(values).some((id) => !orderedIds.has(id))) throw new Error(`${label} order is incomplete or contains duplicates.`);
  };
  validateCompleteOrder(project.tempoOrder, project.tempoEvents, 'Tempo');
  for (const event of Object.values(project.tempoEvents)) {
    const entityError = declaredEntityBaseError(event, 'Tempo event');
    if (entityError) throw new Error(entityError);
    const tempoError = declaredTempoValueError(event);
    if (tempoError) throw new Error(tempoError);
  }
  if (project.tempoOrder.some((id, index) => index > 0 && project.tempoEvents[project.tempoOrder[index - 1]].tick > project.tempoEvents[id].tick)) throw new Error('Tempo order is not chronological.');
  if (!project.tempoOrder.some((id) => project.tempoEvents[id].tick === 0)) throw new Error('Project requires a tempo at tick zero.');
  validateCompleteOrder(project.timeSignatureOrder, project.timeSignatureEvents, 'Meter');
  for (const event of Object.values(project.timeSignatureEvents)) {
    const entityError = declaredEntityBaseError(event, 'Meter event');
    if (entityError) throw new Error(entityError);
    const meterError = declaredMeterValueError(event);
    if (meterError) throw new Error(meterError);
  }
  if (project.timeSignatureOrder.some((id, index) => index > 0 && project.timeSignatureEvents[project.timeSignatureOrder[index - 1]].tick > project.timeSignatureEvents[id].tick)) throw new Error('Meter order is not chronological.');
  if (!project.timeSignatureOrder.some((id) => project.timeSignatureEvents[id].tick === 0)) throw new Error('Project requires a meter at tick zero.');
  validateCompleteOrder(project.markerOrder, project.markers, 'Marker');
  for (const marker of Object.values(project.markers)) {
    const entityError = declaredEntityBaseError(marker, 'Marker');
    if (entityError) throw new Error(entityError);
    const markerError = declaredMarkerTextError(marker);
    if (markerError) throw new Error(markerError);
    const rangeError = declaredMarkerRangeError(marker);
    if (rangeError) throw new Error(rangeError);
  }
  validateCompleteOrder(project.sectionOrder, project.sections, 'Section');
  for (const section of Object.values(project.sections)) {
    const entityError = declaredEntityBaseError(section, 'Section');
    if (entityError) throw new Error(entityError);
    const sectionError = declaredSectionTextError(section);
    if (sectionError) throw new Error(sectionError);
    const rangeError = declaredSectionRangeError(section);
    if (rangeError) throw new Error(rangeError);
    if (section.energy !== undefined && (!Number.isFinite(section.energy) || section.energy < 0 || section.energy > 1)) throw new Error(`Section ${section.id} has an invalid range or energy.`);
  }
  const rootTrackIds = new Set(project.trackOrder);
  if (rootTrackIds.size !== project.trackOrder.length) throw new Error('Track order contains duplicates.');
  for (const trackId of project.trackOrder) {
    const track = project.tracks[trackId];
    if (!track) throw new Error(`Track order references missing track ${trackId}.`);
    if (track.parentId) throw new Error(`Nested track ${track.id} cannot also appear in track order.`);
  }
  for (const track of Object.values(project.tracks)) {
    const entityError = declaredEntityBaseError(track, 'Track');
    if (entityError) throw new Error(entityError);
    const trackError = declaredTrackMutableError(track);
    if (trackError) throw new Error(trackError);
    if (new Set(track.childTrackIds).size !== track.childTrackIds.length) throw new Error(`Track ${track.id} has duplicate child references.`);
    if (track.childTrackIds.length > 0 && track.kind !== 'folder') throw new Error(`Non-folder track ${track.id} cannot contain child tracks.`);
    if (track.parentId) {
      const parent = project.tracks[track.parentId];
      if (!parent) throw new Error(`Track ${track.id} has a missing parent.`);
      if (parent.kind !== 'folder') throw new Error(`Track ${track.id} has a non-folder parent.`);
      if (rootTrackIds.has(track.id)) throw new Error(`Nested track ${track.id} cannot also appear in track order.`);
      if (!parent.childTrackIds.includes(track.id)) throw new Error(`Track ${track.id} is missing from its parent's child order.`);
    } else if (!rootTrackIds.has(track.id)) {
      throw new Error(`Root track ${track.id} is missing from track order.`);
    }
    for (const childId of track.childTrackIds) {
      const child = project.tracks[childId];
      if (!child || child.parentId !== track.id) throw new Error(`Track ${track.id} has an invalid child reference.`);
    }
  }
  const masters = Object.values(project.tracks).filter((track) => track.kind === 'master');
  if (masters.length !== 1) throw new Error('Project must contain exactly one master track.');
  if (masters[0].parentId) throw new Error('Master track cannot be nested.');
  const visited = new Set<Id>(); const stack = new Set<Id>();
  const visit = (trackId: Id): void => { if (stack.has(trackId)) throw new Error('Track hierarchy contains a cycle.'); if (visited.has(trackId)) return; const track = project.tracks[trackId]; if (!track) throw new Error('Track hierarchy references a missing track.'); stack.add(trackId); for (const child of track.childTrackIds) visit(child); stack.delete(trackId); visited.add(trackId); };
  for (const id of project.trackOrder) visit(id);
  for (const id of Object.keys(project.tracks)) if (!visited.has(id)) visit(id);
  for (const track of Object.values(project.tracks)) {
    if (track.routing.outputTrackId && !project.tracks[track.routing.outputTrackId]) throw new Error(`Track ${track.id} has a missing output.`);
    if (new Set(track.clipIds).size !== track.clipIds.length) throw new Error(`Track ${track.id} has duplicate clip references.`);
    for (const clipId of track.clipIds) { const clip = project.clips[clipId]; if (!clip || clip.trackId !== track.id) throw new Error(`Track ${track.id} has an invalid clip reference.`); }
    if (new Set(track.deviceIds).size !== track.deviceIds.length) throw new Error(`Track ${track.id} has duplicate device references.`);
    for (const deviceId of track.deviceIds) { const device = project.devices[deviceId]; if (!device || device.trackId !== track.id) throw new Error(`Track ${track.id} has an invalid device reference.`); }
    if (new Set(track.automationLaneIds).size !== track.automationLaneIds.length) throw new Error(`Track ${track.id} has duplicate automation lane references.`);
    for (const laneId of track.automationLaneIds) { const lane = project.automationLanes[laneId]; if (!lane || lane.trackId !== track.id) throw new Error(`Track ${track.id} has an invalid automation lane reference.`); }
  }
  for (const clip of Object.values(project.clips)) {
    const entityError = declaredEntityBaseError(clip, 'Clip');
    if (entityError) throw new Error(entityError);
    const track = project.tracks[clip.trackId]; if (!track || !track.clipIds.includes(clip.id)) throw new Error(`Clip ${clip.id} is orphaned.`);
    if (!trackAcceptsClip(track, clip)) throw new Error(`Clip ${clip.id} is incompatible with track ${track.id}.`);
    const clipError = declaredClipMutableError(clip);
    if (clipError) throw new Error(clipError);
    const numericError = declaredClipNumericError(clip);
    if (numericError) throw new Error(numericError);
    if (clip.kind === 'audio') {
      const sourceError = declaredAudioClipSourceError(project, clip);
      if (sourceError) throw new Error(sourceError);
      for (const marker of clip.warpMarkers) {
        const entityError = declaredEntityBaseError(marker, 'Warp marker');
        if (entityError) throw new Error(entityError);
        if (!Number.isSafeInteger(marker.sourceSample) || marker.sourceSample < 0 || !Number.isSafeInteger(marker.projectTick) || marker.projectTick < 0) throw new Error(`Audio clip ${clip.id} has invalid warp timing.`);
      }
    }
    if (clip.kind === 'midi') {
      const validateOrder = (order: Id[], values: Record<Id, EntityBase>, label: string): void => {
        if (new Set(order).size !== order.length || order.some((id) => !values[id]) || Object.entries(values).some(([id, value]) => !order.includes(id) || value.id !== id)) throw new Error(`MIDI clip ${clip.id} has an invalid ${label} order.`);
      };
      validateOrder(clip.noteOrder, clip.notes, 'note'); validateOrder(clip.controlOrder, clip.controls, 'control'); validateOrder(clip.pitchBendOrder, clip.pitchBends, 'pitch-bend');
      for (const note of Object.values(clip.notes)) {
        const entityError = declaredEntityBaseError(note, 'MIDI note');
        if (entityError) throw new Error(entityError);
        if (!Number.isInteger(note.startTick) || note.startTick < 0 || !Number.isInteger(note.durationTicks) || note.durationTicks < 1 || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1 || !Number.isFinite(note.releaseVelocity) || note.releaseVelocity < 0 || note.releaseVelocity > 1 || !Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15 || !Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1) throw new Error(`MIDI note ${note.id} has invalid timing or values.`);
      }
      for (const event of Object.values(clip.controls)) {
        const entityError = declaredEntityBaseError(event, 'MIDI control');
        if (entityError) throw new Error(entityError);
        if (!Number.isInteger(event.tick) || event.tick < 0 || !Number.isInteger(event.controller) || event.controller < 0 || event.controller > 127 || !Number.isFinite(event.value) || event.value < 0 || event.value > 1 || !Number.isInteger(event.channel) || event.channel < 0 || event.channel > 15) throw new Error(`MIDI control ${event.id} has invalid timing or values.`);
      }
      for (const event of Object.values(clip.pitchBends)) {
        const entityError = declaredEntityBaseError(event, 'MIDI pitch bend');
        if (entityError) throw new Error(entityError);
        if (!Number.isInteger(event.tick) || event.tick < 0 || !Number.isFinite(event.value) || event.value < -1 || event.value > 1 || !Number.isInteger(event.channel) || event.channel < 0 || event.channel > 15) throw new Error(`MIDI pitch bend ${event.id} has invalid timing or values.`);
      }
    }
    if (clip.takeLaneId) {
      const lane = project.takeLanes[clip.takeLaneId];
      if (!lane) throw new Error(`Clip ${clip.id} references missing take lane ${clip.takeLaneId}.`);
      if (lane.trackId !== clip.trackId) throw new Error(`Clip ${clip.id} and take lane ${lane.id} must reference the same track.`);
      if (!lane.clipIds.includes(clip.id)) throw new Error(`Clip ${clip.id} is missing from reciprocal take lane ${lane.id}.`);
    }
  }
  for (const lane of Object.values(project.takeLanes)) {
    const entityError = declaredEntityBaseError(lane, 'Take lane');
    if (entityError) throw new Error(entityError);
    const laneError = declaredTakeLaneMutableError(lane);
    if (laneError) throw new Error(laneError);
    if (!project.tracks[lane.trackId]) throw new Error(`Take lane ${lane.id} references missing track ${lane.trackId}.`);
    if (new Set(lane.clipIds).size !== lane.clipIds.length) throw new Error(`Take lane ${lane.id} has duplicate clip references.`);
    for (const clipId of lane.clipIds) {
      const clip = project.clips[clipId];
      if (!clip) throw new Error(`Take lane ${lane.id} references missing clip ${clipId}.`);
      if (clip.trackId !== lane.trackId) throw new Error(`Take lane ${lane.id} and clip ${clip.id} must reference the same track.`);
      if (clip.takeLaneId !== lane.id) throw new Error(`Take lane ${lane.id} is not reciprocal with clip ${clip.id}.`);
    }
  }
  for (const segment of Object.values(project.compSegments)) {
    const entityError = declaredEntityBaseError(segment, 'Comp segment');
    if (entityError) throw new Error(entityError);
    const segmentError = declaredCompSegmentError(project, segment);
    if (segmentError) throw new Error(segmentError);
  }
  for (const device of Object.values(project.devices)) {
    const entityError = declaredEntityBaseError(device, 'Device');
    if (entityError) throw new Error(entityError);
    const deviceError = declaredDeviceError(device);
    if (deviceError) throw new Error(deviceError);
    const track = project.tracks[device.trackId];
    if (!track || !track.deviceIds.includes(device.id)) throw new Error(`Device ${device.id} is orphaned.`);
    if (track.kind === 'folder' || track.kind === 'midi') throw new Error(`Device ${device.id} is assigned to an unsupported track kind.`);
    if (device.stateAssetId && !project.assets[device.stateAssetId]) throw new Error(`Device ${device.id} references missing state media.`);
  }
  for (const lane of Object.values(project.automationLanes)) {
    const entityError = declaredEntityBaseError(lane, 'Automation lane');
    if (entityError) throw new Error(entityError);
    const laneError = declaredAutomationLaneError(lane);
    if (laneError) throw new Error(laneError);
    for (const point of Object.values(lane.points)) {
      const pointError = declaredEntityBaseError(point, 'Automation point');
      if (pointError) throw new Error(pointError);
      const valueError = declaredAutomationPointError(point);
      if (valueError) throw new Error(valueError);
    }
    const indexError = declaredAutomationIndexError(lane);
    if (indexError) throw new Error(indexError);
    const track = project.tracks[lane.trackId];
    if (!track || !track.automationLaneIds.includes(lane.id)) throw new Error(`Automation lane ${lane.id} is orphaned.`);
    if (lane.target.kind === 'device' && !project.devices[lane.target.deviceId]) throw new Error(`Automation lane ${lane.id} targets a missing device.`);
    if (new Set(lane.pointOrder).size !== lane.pointOrder.length || lane.pointOrder.some((id) => !lane.points[id]) || Object.keys(lane.points).some((id) => !lane.pointOrder.includes(id))) throw new Error(`Automation lane ${lane.id} has an invalid point order.`);
  }
  for (const send of Object.values(project.sends)) {
    const entityError = declaredEntityBaseError(send, 'Send');
    if (entityError) throw new Error(entityError);
    if (!project.tracks[send.sourceTrackId] || !project.tracks[send.destinationTrackId]) throw new Error(`Send ${send.id} is invalid.`);
    const sendError = declaredSendValueError(send);
    if (sendError) throw new Error(sendError);
  }
  for (const route of Object.values(project.sidechains)) {
    const entityError = declaredEntityBaseError(route, 'Sidechain');
    if (entityError) throw new Error(entityError);
    if (!project.tracks[route.sourceTrackId] || !project.devices[route.destinationDeviceId]) throw new Error(`Sidechain ${route.id} is invalid.`);
    const routeError = declaredSidechainValueError(route);
    if (routeError) throw new Error(routeError);
  }
  for (const asset of Object.values(project.assets)) {
    const entityError = declaredEntityBaseError(asset, 'Media asset');
    if (entityError) throw new Error(entityError);
    const assetError = declaredMediaAssetError(asset);
    if (assetError) throw new Error(assetError);
  }
  for (const deliverable of Object.values(project.sfxDeliverables)) {
    const entityError = declaredEntityBaseError(deliverable, 'SFX deliverable');
    if (entityError) throw new Error(entityError);
    if (typeof deliverable.name !== 'string' || deliverable.name.length < 1 || deliverable.name.length > 500 || !Array.isArray(deliverable.tags) || deliverable.tags.length > 100 || deliverable.tags.some((tag) => typeof tag !== 'string' || tag.length > 100) || typeof deliverable.namingTemplate !== 'string' || deliverable.namingTemplate.length < 1 || deliverable.namingTemplate.length > 500 || !['wav', 'flac', 'mp3'].includes(deliverable.exportFormat)) throw new Error(`SFX deliverable ${deliverable.id} has invalid text or format values.`);
    if (!Number.isInteger(deliverable.startTick) || deliverable.startTick < 0 || !Number.isInteger(deliverable.endTick) || deliverable.endTick <= deliverable.startTick || !Number.isInteger(deliverable.variantCount) || deliverable.variantCount < 1 || deliverable.variantCount > 1_000) throw new Error(`SFX deliverable ${deliverable.id} has an invalid range or variant count.`);
    if (typeof deliverable.seamlessLoop !== 'boolean' || (deliverable.loopStartSample !== undefined && (!Number.isInteger(deliverable.loopStartSample) || deliverable.loopStartSample < 0)) || (deliverable.loopEndSample !== undefined && (!Number.isInteger(deliverable.loopEndSample) || deliverable.loopEndSample < 0))) throw new Error(`SFX deliverable ${deliverable.id} has invalid loop point values.`);
    if ((deliverable.loopStartSample === undefined) !== (deliverable.loopEndSample === undefined)) throw new Error(`SFX deliverable ${deliverable.id} has incomplete loop points.`);
    if (deliverable.loopStartSample !== undefined && deliverable.loopEndSample! <= deliverable.loopStartSample) throw new Error(`SFX deliverable ${deliverable.id} has invalid loop points.`);
    const variation = deliverable.variation;
    if (!Number.isInteger(deliverable.tailMilliseconds) || deliverable.tailMilliseconds < 0 || deliverable.tailMilliseconds > 60_000 || !variation || !Number.isInteger(variation.seed) || !Number.isFinite(variation.pitchRangeSemitones) || variation.pitchRangeSemitones < 0 || variation.pitchRangeSemitones > 24 || !Number.isFinite(variation.gainRangeDb) || variation.gainRangeDb < 0 || variation.gainRangeDb > 24 || !Number.isFinite(variation.timingRangeMilliseconds) || variation.timingRangeMilliseconds < 0 || variation.timingRangeMilliseconds > 5_000) throw new Error(`SFX deliverable ${deliverable.id} has invalid tail or variation values.`);
    if (!Number.isFinite(deliverable.targetLufs) || deliverable.targetLufs < -36 || deliverable.targetLufs > -5) throw new Error(`SFX deliverable ${deliverable.id} has an invalid loudness target.`);
  }
  for (const checkpoint of Object.values(project.checkpoints)) {
    const entityError = declaredEntityBaseError(checkpoint, 'Checkpoint');
    if (entityError) throw new Error(entityError);
    const checkpointError = declaredCheckpointError(checkpoint);
    if (checkpointError) throw new Error(checkpointError);
    if (!project.assets[checkpoint.snapshotAssetId]) throw new Error(`Checkpoint ${checkpoint.id} is invalid.`);
  }
  for (const value of Object.values(project.provenance)) {
    const entityError = declaredEntityBaseError(value, 'Generation provenance');
    if (entityError) throw new Error(entityError);
    const provenanceError = declaredProvenanceError(value);
    if (provenanceError) throw new Error(provenanceError);
    if (!project.assets[value.assetId] || value.referenceAssetIds.some((id) => !project.assets[id])) throw new Error(`Generation provenance ${value.id} is invalid.`);
  }
  for (const value of Object.values(project.variants)) {
    const entityError = declaredEntityBaseError(value, 'Variant');
    if (entityError) throw new Error(entityError);
    const variantError = declaredVariantMutableError(value);
    if (variantError) throw new Error(variantError);
    if (!project.checkpoints[value.baseCheckpointId] || (value.snapshotAssetId && !project.assets[value.snapshotAssetId])) throw new Error(`Variant ${value.id} is invalid.`);
  }
  const masterId = masters[0].id;
  for (const track of Object.values(project.tracks)) {
    if (track.kind === 'master') continue;
    const seen = new Set<Id>([track.id]); let cursor = track.routing.outputTrackId ?? masterId;
    while (cursor !== masterId) { if (seen.has(cursor)) throw new Error('Audio routing contains a cycle.'); seen.add(cursor); const next = project.tracks[cursor]; if (!next) throw new Error('Audio routing references a missing track.'); cursor = next.routing.outputTrackId ?? masterId; }
  }
  for (const track of Object.values(project.tracks)) {
    const kindError = declaredTrackKindError(track);
    if (kindError) throw new Error(kindError);
  }
}

export function applyProjectTransaction(project: AIMuseProject, transaction: ProjectTransaction, options: ReducerOptions = {}): ReducerResult {
  if (transaction.projectId !== project.id) throw new Error('Transaction targets a different project.');
  const maxOperations = options.maxOperations ?? 512;
  if (!transaction.operations.length || transaction.operations.length > maxOperations) throw new Error(`Transactions require 1–${maxOperations} operations.`);
  const actor = options.authenticatedActor ? structuredClone(options.authenticatedActor) : structuredClone(transaction.actor);
  const timestamp = nowIso();
  const normalized: ProjectTransaction = { ...structuredClone(transaction), actor, createdAt: timestamp };
  const [next, patches, inversePatches] = produceWithPatches(project, (draft) => {
    normalized.operations.forEach((operation, index) => applyOperation(draft as AIMuseProject, operation, index, normalized, actor, timestamp));
    draft.revision += 1; draft.updatedAt = timestamp; draft.dirty = true;
    draft.activity.push({ id: createId('activity'), actor, transactionId: normalized.id, label: normalized.label, status: 'committed', createdAt: timestamp, revision: draft.revision });
    trimRecentActivity(draft.activity);
  });
  validateProjectIntegrity(next);
  return { project: next, transaction: normalized, patches, inversePatches };
}

const HISTORY_ROOT_METADATA = new Set(['revision', 'updatedAt', 'dirty', 'activity']);
const HISTORY_ENTITY_METADATA = new Set(['revision', 'updatedAt', 'updatedBy']);

function historyContentPatch(patch: Patch): boolean {
  const first = patch.path[0];
  const last = patch.path.at(-1);
  if (typeof first === 'string' && HISTORY_ROOT_METADATA.has(first)) return false;
  return !(typeof last === 'string' && HISTORY_ENTITY_METADATA.has(last));
}

function valueAt(root: unknown, path: ReadonlyArray<string | number>): { exists: boolean; value?: unknown; parent?: unknown } {
  let value = root;
  for (let index = 0; index < path.length; index += 1) {
    if (value === null || typeof value !== 'object') return { exists: false };
    const key = path[index];
    const parent: unknown = value;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { exists: false, parent };
    value = (value as Record<string | number, unknown>)[key];
    if (index === path.length - 1) return { exists: true, value, parent };
  }
  return { exists: true, value };
}

function patchPathKey(path: ReadonlyArray<string | number>): string { return JSON.stringify(path); }

function selectHistoryPatch(working: AIMuseProject, patch: Patch, expected: Patch): Patch | undefined {
  const found = valueAt(working, expected.path);
  if (expected.op === 'remove') {
    if (Array.isArray(found.parent) && patch.op === 'add') {
      if (found.parent.some((value) => isDeepStrictEqual(value, patch.value))) return undefined;
      return { ...patch, path: [...patch.path.slice(0, -1), Math.min(Number(patch.path.at(-1)), found.parent.length)] };
    }
    return found.exists ? undefined : patch;
  }
  if (found.exists && isDeepStrictEqual(found.value, expected.value)) return patch;
  if (Array.isArray(found.parent)) {
    const index = found.parent.findIndex((value) => isDeepStrictEqual(value, expected.value));
    if (index >= 0) return { ...patch, path: [...patch.path.slice(0, -1), index] };
  }
  return undefined;
}

function isEntity(value: unknown): value is EntityBase {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EntityBase>;
  return typeof candidate.id === 'string' && Number.isInteger(candidate.revision) && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string' && typeof candidate.createdBy === 'string' && typeof candidate.updatedBy === 'string';
}

function touchHistoryEntities(restored: AIMuseProject, previous: AIMuseProject, paths: Array<ReadonlyArray<string | number>>, actor: Actor, timestamp: string): void {
  const touched = new Set<string>();
  for (const path of paths) for (let length = 1; length <= path.length; length += 1) {
    const prefix = path.slice(0, length);
    const candidate = valueAt(restored, prefix);
    if (!candidate.exists || !isEntity(candidate.value)) continue;
    const key = patchPathKey(prefix); if (touched.has(key)) continue; touched.add(key);
    const previousValue = valueAt(previous, prefix).value;
    candidate.value.revision = Math.max(candidate.value.revision, isEntity(previousValue) ? previousValue.revision : -1) + 1;
    candidate.value.updatedAt = timestamp;
    candidate.value.updatedBy = actor.id;
  }
}

export function applyHistoryPatches(project: AIMuseProject, patches: Patch[], actor: Actor, label: string, status: 'undo' | 'redo', expectedPatches?: Patch[]): AIMuseProject {
  let restored: AIMuseProject;
  const appliedPaths: Array<ReadonlyArray<string | number>> = [];
  if (expectedPatches) {
    const expectedByPath = new Map(expectedPatches.map((patch) => [patchPathKey(patch.path), patch]));
    let working = structuredClone(project);
    let applicable = 0;
    let skipped = 0;
    for (const patch of patches) {
      if (!historyContentPatch(patch)) continue;
      applicable += 1;
      const expected = expectedByPath.get(patchPathKey(patch.path));
      const selected = expected ? selectHistoryPatch(working, patch, expected) : undefined;
      if (!selected) { skipped += 1; continue; }
      working = applyPatches(working, [selected]) as AIMuseProject;
      appliedPaths.push(selected.path);
    }
    if (skipped > 0) throw new Error('This history entry overlaps newer edits and cannot be applied safely.');
    restored = structuredClone(working);
    if (applicable > 0 && appliedPaths.length === 0) throw new Error('This history entry no longer matches the current project.');
  } else {
    restored = structuredClone(applyPatches(project, patches)) as AIMuseProject;
    appliedPaths.push(...patches.filter(historyContentPatch).map((patch) => patch.path));
  }
  const timestamp = nowIso();
  touchHistoryEntities(restored, project, appliedPaths, actor, timestamp);
  restored.revision = project.revision + 1;
  restored.updatedAt = timestamp;
  restored.dirty = true;
  restored.activity.push({ id: createId('activity'), actor: structuredClone(actor), label, status, createdAt: timestamp, revision: restored.revision });
  trimRecentActivity(restored.activity);
  validateProjectIntegrity(restored);
  return restored;
}
