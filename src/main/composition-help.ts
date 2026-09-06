import { z } from 'zod';
import { createId, nowIso, OperationKinds, projectOperationSchema } from '@aimuse/core';

export const PUBLIC_OPERATION_KINDS = OperationKinds.filter((kind) => !['asset.add', 'provenance.register', 'provenance.update', 'checkpoint.register', 'variant.register', 'variant.update'].includes(kind));
export const OPERATION_SCHEMAS = Object.fromEntries(PUBLIC_OPERATION_KINDS.map((kind) => {
  const schema = z.toJSONSchema(projectOperationSchema(kind), { target: 'draft-7', io: 'input' });
  delete schema.$schema; return [kind, schema];
}));

/** Returned through public help. A fresh client can submit this without reading source. */
export function compositionExample(projectId: string, actorId: string): Record<string, unknown> {
  const timestamp = nowIso();
  const entity = (prefix: string) => ({ id: createId(prefix), revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actorId, updatedBy: actorId });
  const track = { ...entity('track'), kind: 'instrument', name: 'Help melody', color: '#8b5cf6', clipIds: [], deviceIds: [], automationLaneIds: [], childTrackIds: [], gainDb: 0, pan: 0, mute: false, solo: false, armed: false, frozen: false, collapsed: false, routing: { monitor: 'off' } };
  const clip = { ...entity('clip'), kind: 'midi', trackId: track.id, name: 'Help phrase', color: track.color, startTick: 0, durationTicks: 3840, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 240, curve: 'equal-power' }, loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [] };
  const parameter = (id: string, value: number, min: number, max: number) => ({ id, name: id, value, defaultValue: value, min, max, automatable: true });
  const synth = { ...entity('device'), trackId: track.id, format: 'builtin', builtinKind: 'subtractive-synth', name: 'Muse Synth', bypassed: false, degraded: false, latencySamples: 0, parameters: { cutoff: parameter('cutoff', 8000, 20, 20000), resonance: parameter('resonance', 0.15, 0, 1), attack: parameter('attack', 0.01, 0, 5), release: parameter('release', 0.4, 0, 10) } };
  const utility = { ...entity('device'), trackId: track.id, format: 'builtin', builtinKind: 'utility', name: 'Utility', bypassed: false, degraded: false, latencySamples: 0, parameters: { gain: parameter('gain', -3, -48, 24), width: parameter('width', 1, 0, 2) } };
  const deliverable = { ...entity('sfx'), name: 'Help loop', startTick: 0, endTick: 3840, variantCount: 3, tags: ['example'], seamlessLoop: true, tailMilliseconds: 0, variation: { seed: 42, pitchRangeSemitones: 0.5, gainRangeDb: 0.2, timingRangeMilliseconds: 1 }, targetLufs: -18, namingTemplate: '{name}-{index}', exportFormat: 'wav' };
  return { projectId, clientOperationId: createId('example'), label: 'Compose the help melody', commitMode: 'direct', operations: [
    { kind: 'track.add', track }, { kind: 'clip.add', clip }, { kind: 'device.add', device: synth }, { kind: 'device.add', device: utility },
    ...[60, 64, 67, 72].map((pitch, index) => ({ kind: 'midi.note.add', clipId: clip.id, note: { ...entity('note'), startTick: index * 960, durationTicks: 840, pitch, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 } })),
    { kind: 'sfx-deliverable.add', deliverable },
  ] };
}
export const COMPOSITION_RULES = [
  'Read project_observe first. project.settings.ppq is 960 ticks per quarter note; note/CC/bend ticks are clip-relative, clip/marker/region ticks are project-absolute. MIDI channels are 0–15; velocity and CC values are 0–1; pitch bend is -1–1.',
  'Choose unique nonempty entity IDs (up to 240 characters); use the same IDs for references in later operations in the atomic batch. Entity creation requires revision:0, ISO createdAt/updatedAt and createdBy/updatedBy strings. These are input placeholders: the server overwrites attribution and timestamps using the authenticated actor and trusted clock.',
  'Creation payloads contain every required field in the nested schema. Empty collections are still required. track.add/clip.add/device.add and MIDI operations maintain their parent ID/order lists; do not manually add IDs to those lists before the corresponding add operation.',
  'expectedRevision is the current target entity revision, not project.revision. Re-observe after a commit. Within one batch omit expectedRevision on new entities or account for earlier operations incrementing the same entity revision.',
  'clientOperationId identifies one intent; reuse exactly the same request when checking an uncertain commit. Use a new key for a new edit. Top-level actor/time/transaction IDs are supplied by AIMuse.',
  'SFX loopStartSample and loopEndSample must be supplied together, with end greater than start, in project-rate samples relative to the rendered deliverable. Clip loopEnabled requires a positive loopLengthTicks for rendering.',
  'Use media_manage import for WAV assets and project_manage for checkpoints/branches. asset.add, provenance writes and checkpoint/variant registration are server-owned and unavailable through project_apply.',
  'Render only the subset in aimuse_help rendering. A stored device or automation operation can be valid project data while its audio processing remains unsupported. Inspect job status, error and result.warnings; completed does not imply every deliverable codec was available.',
];
