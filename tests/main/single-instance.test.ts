import { describe, expect, it } from 'vitest';
import { evaluateShowRequest, parseSecondInstanceRequest, parseStartupRequest, shouldAcceptQuit, shouldAcceptShow, shouldInitializePrimary } from '../../src/main/single-instance';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const RECYCLED = '22222222-2222-4222-8222-222222222222';
const PROFILE = 'A'.repeat(64);
const OTHER_PROFILE = 'B'.repeat(64);
const REQUEST = '33333333-3333-4333-8333-333333333333';

describe('instance-bound single-instance commands', () => {
  it('carries the requested engine instance with a quit command', () => {
    expect(parseStartupRequest(['--headless'])).toEqual({ command: 'headless', instanceId: undefined, profileId: undefined, showRequestId: undefined });
    expect(parseStartupRequest(['--quit-engine', `--quit-engine-instance=${CURRENT}`])).toEqual({ command: 'quit-engine', instanceId: CURRENT, profileId: undefined, showRequestId: undefined });
    expect(parseStartupRequest([`--show-engine-instance=${CURRENT}`, `--show-profile-id=${PROFILE}`, `--show-request-id=${REQUEST}`])).toEqual({ command: 'show', instanceId: CURRENT, profileId: PROFILE, showRequestId: REQUEST });
  });

  it('binds show to the current owner and prevents a bound helper from becoming a new owner', () => {
    expect(shouldAcceptShow(CURRENT, CURRENT)).toBe(true);
    expect(shouldAcceptShow(RECYCLED, CURRENT)).toBe(false);
    expect(shouldAcceptShow(null, CURRENT)).toBe(false);
    expect(shouldAcceptShow(undefined, CURRENT)).toBe(true);
    expect(shouldInitializePrimary({ command: 'show', instanceId: CURRENT })).toBe(false);
    expect(shouldInitializePrimary({ command: 'show', instanceId: null })).toBe(false);
    expect(shouldInitializePrimary({ command: 'show', instanceId: undefined })).toBe(true);
    expect(shouldInitializePrimary({ command: 'show', profileId: PROFILE })).toBe(false);
    expect(shouldInitializePrimary({ command: 'show', showRequestId: REQUEST })).toBe(false);
    expect(shouldInitializePrimary({ command: 'headless', instanceId: undefined })).toBe(true);
    expect(shouldInitializePrimary({ command: 'quit-engine', instanceId: undefined })).toBe(false);
  });

  it('accepts one exact receiver-bound request and classifies rejection without treating it as legacy', () => {
    expect(evaluateShowRequest({ command: 'show' }, CURRENT, PROFILE)).toEqual({ accepted: true, legacy: true });
    expect(evaluateShowRequest({ command: 'show', instanceId: CURRENT, profileId: PROFILE, showRequestId: REQUEST }, CURRENT, PROFILE)).toEqual({ accepted: true, legacy: false, requestId: REQUEST });
    expect(evaluateShowRequest({ command: 'show', instanceId: RECYCLED, profileId: PROFILE, showRequestId: REQUEST }, CURRENT, PROFILE)).toEqual({ accepted: false, legacy: false, requestId: REQUEST, rejection: 'instance-mismatch' });
    expect(evaluateShowRequest({ command: 'show', instanceId: CURRENT, profileId: OTHER_PROFILE, showRequestId: REQUEST }, CURRENT, PROFILE)).toEqual({ accepted: false, legacy: false, requestId: REQUEST, rejection: 'profile-mismatch' });
    expect(evaluateShowRequest({ command: 'show', instanceId: CURRENT, profileId: PROFILE, showRequestId: null }, CURRENT, PROFILE)).toEqual({ accepted: false, legacy: false, requestId: undefined, rejection: 'malformed-request' });
  });

  it('accepts only a matching instance-bound quit while retaining explicit legacy compatibility', () => {
    expect(shouldAcceptQuit(CURRENT, CURRENT)).toBe(true);
    expect(shouldAcceptQuit(RECYCLED, CURRENT)).toBe(false);
    expect(shouldAcceptQuit(null, CURRENT)).toBe(false);
    expect(shouldAcceptQuit(undefined, CURRENT)).toBe(true);
  });

  it('rejects malformed instance data instead of treating it as a legacy request', () => {
    expect(parseSecondInstanceRequest({ command: 'quit-engine', instanceId: 42 }, ['--quit-engine'])).toEqual({ command: 'quit-engine', instanceId: null, profileId: undefined, showRequestId: undefined });
    expect(parseSecondInstanceRequest({ command: 'quit-engine', instanceId: RECYCLED }, [])).toEqual({ command: 'quit-engine', instanceId: RECYCLED, profileId: undefined, showRequestId: undefined });
    expect(parseSecondInstanceRequest({ command: 'show', instanceId: CURRENT, profileId: 42, showRequestId: REQUEST }, [])).toEqual({ command: 'show', instanceId: CURRENT, profileId: null, showRequestId: REQUEST });
  });
});
