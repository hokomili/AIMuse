import { describe, expect, it } from 'vitest';
import { assertCredentialFreeEvidence, assertPrivateWindowsAcl, validateRestartIdentity } from '../../scripts/qa-headless-restart.mjs';

const USER = 'S-1-5-21-111-222-333-1001';
const PROFILE = 'A'.repeat(64);

describe('AGT-04 isolated headless restart evidence guards', () => {
  it('accepts only an owner-protected Windows root without broad principals', () => {
    expect(assertPrivateWindowsAcl({
      protected: true,
      ownerSid: USER,
      rules: [
        { sid: USER, type: 'Allow', inherited: false, rights: 'FullControl' },
        { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
        { sid: 'S-1-5-32-544', type: 'Allow', inherited: false, rights: 'FullControl' },
      ],
    }, USER, { requireProtected: true })).toEqual({
      owner: 'launching-user',
      allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
      inheritedFromBroadParent: false,
    });
  });

  it.each([
    ['inherited root', { protected: false, ownerSid: USER, rules: [{ sid: USER, type: 'Allow', rights: 'FullControl' }] }],
    ['broad local users', { protected: true, ownerSid: USER, rules: [{ sid: USER, type: 'Allow', rights: 'FullControl' }, { sid: 'S-1-5-32-545', type: 'Allow', rights: 'ReadAndExecute' }] }],
    ['wrong owner', { protected: true, ownerSid: 'S-1-5-21-999-888-777-1002', rules: [{ sid: USER, type: 'Allow', rights: 'FullControl' }] }],
  ])('rejects a non-private %s ACL', (_case, acl) => {
    expect(() => assertPrivateWindowsAcl(acl, USER, { requireProtected: true })).toThrow();
  });

  it('requires a fresh PID and instance while retaining the exact profile identity', () => {
    const first = { pid: 41001, instanceId: '11111111-1111-4111-8111-111111111111', profileId: PROFILE };
    const second = { pid: 41002, instanceId: '22222222-2222-4222-8222-222222222222', profileId: PROFILE };
    expect(validateRestartIdentity(first, second)).toEqual({ pidChanged: true, instanceChanged: true, profileRetained: true });
    expect(() => validateRestartIdentity(first, { ...second, pid: first.pid })).toThrow('reused the original PID');
    expect(() => validateRestartIdentity(first, { ...second, instanceId: first.instanceId })).toThrow('reused the original engine instance ID');
    expect(() => validateRestartIdentity(first, { ...second, profileId: 'B'.repeat(64) })).toThrow('changed the isolated profile identity');
  });

  it('rejects credential keys and bearer-shaped values from retained evidence', () => {
    expect(assertCredentialFreeEvidence({ stopped: true, credentialsRedacted: true }, 'fixture')).toBe(true);
    expect(() => assertCredentialFreeEvidence({ nested: { token: 'fixture-secret' } }, 'fixture')).toThrow('credential-bearing keys');
    expect(() => assertCredentialFreeEvidence({ message: 'Bearer fixture-secret-value' }, 'fixture')).toThrow('bearer value');
  });
});

