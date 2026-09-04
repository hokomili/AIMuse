export type SingleInstanceCommand = 'show' | 'headless' | 'quit-engine';

export interface SingleInstanceRequest {
  command: SingleInstanceCommand;
  instanceId?: string | null;
  profileId?: string | null;
  showRequestId?: string | null;
}

export type ShowRequestRejection = 'instance-mismatch' | 'malformed-request' | 'profile-mismatch';
export type ShowRequestDecision =
  | { accepted: true; legacy: boolean; requestId?: string }
  | { accepted: false; legacy: false; requestId?: string; rejection: ShowRequestRejection };

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[0-9a-f]{64}$/i;

function valueFlag(arguments_: string[], name: string): string | undefined {
  return arguments_.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function nullableFlag(arguments_: string[], name: string): string | null | undefined {
  const value = valueFlag(arguments_, name);
  return value === '' ? null : value;
}

export function parseStartupRequest(arguments_: string[]): SingleInstanceRequest {
  const command: SingleInstanceCommand = arguments_.includes('--quit-engine') ? 'quit-engine' : arguments_.includes('--headless') ? 'headless' : 'show';
  const instanceId = command === 'quit-engine'
    ? nullableFlag(arguments_, '--quit-engine-instance')
    : command === 'show'
      ? nullableFlag(arguments_, '--show-engine-instance')
      : undefined;
  const profileId = command === 'show' ? nullableFlag(arguments_, '--show-profile-id') : undefined;
  const showRequestId = command === 'show' ? nullableFlag(arguments_, '--show-request-id') : undefined;
  return { command, instanceId, profileId, showRequestId };
}

export function parseSecondInstanceRequest(data: unknown, commandLine: string[]): SingleInstanceRequest {
  const fallback = parseStartupRequest(commandLine);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
  const record = data as Record<string, unknown>;
  const command = ['show', 'headless', 'quit-engine'].includes(String(record.command)) ? String(record.command) as SingleInstanceCommand : fallback.command;
  const field = (key: 'instanceId' | 'profileId' | 'showRequestId'): string | null | undefined => Object.hasOwn(record, key)
    ? typeof record[key] === 'string' && record[key] ? record[key] : null
    : fallback[key];
  return { command, instanceId: field('instanceId'), profileId: field('profileId'), showRequestId: field('showRequestId') };
}

export function shouldAcceptQuit(requestedInstanceId: string | null | undefined, currentInstanceId: string): boolean {
  return requestedInstanceId === undefined || requestedInstanceId === currentInstanceId;
}

export function shouldAcceptShow(requestedInstanceId: string | null | undefined, currentInstanceId: string): boolean {
  return requestedInstanceId === undefined || requestedInstanceId === currentInstanceId;
}

export function evaluateShowRequest(request: SingleInstanceRequest, currentInstanceId: string, currentProfileId: string): ShowRequestDecision {
  const unbound = request.instanceId === undefined && request.profileId === undefined && request.showRequestId === undefined;
  if (unbound) return { accepted: true, legacy: true };
  const requestId = typeof request.showRequestId === 'string' && INSTANCE_ID.test(request.showRequestId) ? request.showRequestId.toLowerCase() : undefined;
  if (typeof request.instanceId !== 'string' || !INSTANCE_ID.test(request.instanceId) || typeof request.profileId !== 'string' || !PROFILE_ID.test(request.profileId) || !requestId) return { accepted: false, legacy: false, requestId, rejection: 'malformed-request' };
  if (request.instanceId.toLowerCase() !== currentInstanceId.toLowerCase()) return { accepted: false, legacy: false, requestId, rejection: 'instance-mismatch' };
  if (request.profileId.toUpperCase() !== currentProfileId.toUpperCase()) return { accepted: false, legacy: false, requestId, rejection: 'profile-mismatch' };
  return { accepted: true, legacy: false, requestId };
}

/** A bound show request is an attach signal, never permission to create a new profile owner. */
export function shouldInitializePrimary(request: SingleInstanceRequest): boolean {
  return request.command === 'headless' || (request.command === 'show' && request.instanceId === undefined && request.profileId === undefined && request.showRequestId === undefined);
}

/** A no-window engine or command helper must never register as a foreground macOS app. */
export function shouldStartInBackground(request: SingleInstanceRequest): boolean {
  return request.command === 'headless' || !shouldInitializePrimary(request);
}
