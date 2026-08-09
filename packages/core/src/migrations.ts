import type { AIMuseProject } from './model';
import { validateProject } from './schemas';

export function migrateProject(value: unknown): AIMuseProject {
  if (!value || typeof value !== 'object') throw new Error('AIMuse project must be an object.');
  const candidate = structuredClone(value) as Record<string, unknown>;
  if (candidate.format !== 'AIMuse') throw new Error('Not an AIMuse project.');
  if (candidate.schemaVersion !== 1) throw new Error(`Unsupported AIMuse schema version: ${String(candidate.schemaVersion)}.`);
  // Early schema-1 projects predated first-class pitch-bend events. Keep them readable
  // without weakening strict validation for newly written projects.
  if (candidate.clips && typeof candidate.clips === 'object') {
    for (const clip of Object.values(candidate.clips as Record<string, unknown>)) {
      if (!clip || typeof clip !== 'object' || (clip as Record<string, unknown>).kind !== 'midi') continue;
      const midi = clip as Record<string, unknown>;
      midi.pitchBends ??= {};
      midi.pitchBendOrder ??= [];
    }
  }
  // Schema-1 SFX deliverables originally had a fixed renderer. Backfill the
  // deterministic variation contract used by current batch exports.
  if (candidate.sfxDeliverables && typeof candidate.sfxDeliverables === 'object') {
    for (const deliverable of Object.values(candidate.sfxDeliverables as Record<string, unknown>)) {
      if (!deliverable || typeof deliverable !== 'object') continue;
      const sfx = deliverable as Record<string, unknown>;
      sfx.tailMilliseconds ??= 0;
      sfx.variation ??= { seed: 1, pitchRangeSemitones: 0, gainRangeDb: 0, timingRangeMilliseconds: 0 };
    }
  }
  return validateProject(candidate);
}
