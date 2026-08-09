import type { AIMuseProject, Id, TransportState } from '@aimuse/core';

export const AUDIO_PROTOCOL_VERSION = 1;

export type AudioHostRequest =
  | { version: 1; id: Id; method: 'hello'; params: { appVersion: string } }
  | { version: 1; id: Id; method: 'prepare-project'; params: { projectId: Id; revision: number; project: AIMuseProject } }
  | { version: 1; id: Id; method: 'commit-project'; params: { projectId: Id; revision: number } }
  | { version: 1; id: Id; method: 'abort-project'; params: { projectId: Id; revision: number } }
  | { version: 1; id: Id; method: 'load-playback'; params: { projectId: Id; revision: number; previewPath: string; preserveTransport: boolean } }
  | { version: 1; id: Id; method: 'transport'; params: { action: 'play' | 'record' | 'pause' | 'stop' | 'seek' | 'loop'; projectId?: Id; tick?: number; sample?: number; loopEnabled?: boolean; loopStartTick?: number; loopEndTick?: number; loopStartSample?: number; loopEndSample?: number } }
  | { version: 1; id: Id; method: 'render'; params: { project: AIMuseProject; startTick: number; endTick: number; destination: string; stems?: Id[] } }
  | { version: 1; id: Id; method: 'shutdown'; params: Record<string, never> };

export interface AudioHostResponse<T = unknown> {
  version: 1;
  id: Id;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean };
}

export type AudioHostEvent =
  | { version: 1; event: 'transport'; state: TransportState }
  | { version: 1; event: 'meter'; projectId: Id; trackId: Id; peakL: number; peakR: number; rmsL: number; rmsR: number }
  | { version: 1; event: 'xrun'; count: number }
  | { version: 1; event: 'plugin-crash'; deviceId: Id; message: string };
