import type { GenerationKind, GenerationProvider, Id, MediaAsset } from '@aimuse/core';

export interface ProviderCapabilities {
  provider: GenerationProvider;
  configured: boolean;
  experimental: boolean;
  models: Array<{
    id: string;
    label: string;
    capabilities: Array<'text-to-music' | 'vocals' | 'custom-lyrics' | 'section-plan' | 'section-replace' | 'audio-reference' | 'text-to-sfx' | 'seamless-loop' | 'audio-to-audio'>;
    minDurationMs: number;
    maxDurationMs: number;
    formats: Array<'wav' | 'mp3' | 'pcm' | 'opus'>;
    costKnownBeforeRequest: boolean;
  }>;
  unavailableReason?: string;
}

export interface GenerationRequest {
  projectId: Id;
  provider: GenerationProvider;
  model: string;
  kind: GenerationKind;
  prompt: string;
  negativePrompt?: string;
  lyrics?: string;
  instrumental: boolean;
  durationMs: number;
  resultCount: number;
  seed?: number;
  referenceAssetIds: Id[];
  targetRange?: { startTick: number; endTick: number };
  structure?: Array<{ name: string; startMs: number; endMs: number; prompt?: string; lyrics?: string }>;
  seamlessLoop?: boolean;
  outputFormat: 'wav' | 'mp3' | 'pcm' | 'opus';
  rightsDeclaration: 'original' | 'licensed' | 'owned-reference';
  estimatedCostMinor?: number;
  currency?: string;
  providerOptions: Record<string, unknown>;
}

export interface GenerationCandidate {
  id: Id;
  requestId?: string;
  asset: MediaAsset;
  managedPath: string;
  waveformAssetId?: Id;
  spectrogramAssetId?: Id;
  costMinor?: number;
  currency?: string;
  providerMetadata: Record<string, unknown>;
}

export interface GenerationJobResult {
  request: GenerationRequest;
  candidates: GenerationCandidate[];
  acceptedCandidateIds: Id[];
  rejectedCandidateIds: Id[];
}
