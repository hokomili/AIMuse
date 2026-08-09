import type { GenerationProvider } from './model';

export interface AuthorityBudget {
  currency: string;
  maxSpendMinor: number;
  maxGenerationRequests: number;
  maxUnknownCostRequests: number;
}

export interface AuthorityPolicy {
  version: 1;
  id: string;
  issuedAt: string;
  expiresAt: string;
  maxRuntimeMinutes: number;
  budget: AuthorityBudget;
  providers: Partial<Record<GenerationProvider, { models: string[]; enabled: boolean }>>;
  readRoots: string[];
  writeRoots: string[];
  overwritePaths: string[];
  pluginAllowlist: string[];
  allowMicrophone: boolean;
  allowMidiInput: boolean;
  allowMidiOutput: boolean;
}

export interface AuthorityUsage {
  spentMinor: number;
  generationRequests: number;
  unknownCostRequests: number;
  startedAt: string;
}

export interface AuthorityDecision {
  allowed: boolean;
  reason?: string;
  approvalKind?: 'file-read' | 'file-write' | 'overwrite' | 'generation' | 'recording' | 'plugin' | 'unknown-cost';
}
