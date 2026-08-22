export interface AuthorityPolicy {
  version: 1;
  id: string;
  issuedAt: string;
  expiresAt: string;
  maxRuntimeMinutes: number;
  readRoots: string[];
  writeRoots: string[];
  overwritePaths: string[];
  pluginAllowlist: string[];
  allowMicrophone: boolean;
  allowMidiInput: boolean;
  allowMidiOutput: boolean;
}

export interface AuthorityUsage {
  startedAt: string;
}

export interface AuthorityDecision {
  allowed: boolean;
  reason?: string;
  approvalKind?: 'file-read' | 'file-write' | 'overwrite' | 'recording' | 'plugin';
}
