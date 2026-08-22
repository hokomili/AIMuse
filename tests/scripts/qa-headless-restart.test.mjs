import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { assertCredentialFreeEvidence, assertPackageSubjectEvidence, assertPrivateWindowsAcl, parseDarwinRelevantProcesses, resolvePackageSubjectRequest, reverifyHeadlessPackageSubjectAtRestart, validateEphemeralAuthority, validateRestartIdentity, verifyHeadlessPackageSubject } from '../../scripts/qa-headless-restart.mjs';

const USER = 'S-1-5-21-111-222-333-1001';
const PROFILE = 'A'.repeat(64);
const SUBJECT_MANIFEST = resolve('test-results', 'formal-package-subject.json');
const SUBJECT_DIGEST = 'A'.repeat(64);
const SUBJECT_IDENTITY = 'B'.repeat(64);
const SUBJECT_EXE = resolve('out', 'formal-fixture', 'AIMuse');

describe('AGT-04 isolated headless restart evidence guards', () => {
  it('finds AIMuse macOS app, helper and native processes without matching the Node coordinator', () => {
    expect(parseDarwinRelevantProcesses([
      '  101 /Applications/AIMuse.app/Contents/MacOS/AIMuse',
      '  102 /Applications/AIMuse.app/Contents/Frameworks/AIMuse Helper (Renderer).app/Contents/MacOS/AIMuse Helper (Renderer)',
      '  103 /Applications/AIMuse.app/Contents/Resources/native/aimuse-audio',
      '  104 /usr/local/bin/node',
    ].join('\n'))).toEqual([
      { name: 'AIMuse', pid: 101 },
      { name: 'AIMuse Helper (Renderer)', pid: 102 },
      { name: 'aimuse-audio', pid: 103 },
    ]);
  });
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

  it('requires fresh 32-byte engine-scoped MCP authority across restart', () => {
    const first = 'A'.repeat(43);
    const second = 'B'.repeat(43);
    expect(validateEphemeralAuthority(first, second)).toEqual({ authorityRotated: true });
    expect(() => validateEphemeralAuthority(first, first)).toThrow('reused engine-scoped MCP authority');
    expect(() => validateEphemeralAuthority('too-short', second)).toThrow('32-byte base64url');
  });

  it('rejects credential keys and bearer-shaped values from retained evidence', () => {
    expect(assertCredentialFreeEvidence({ stopped: true, credentialsRedacted: true }, 'fixture')).toBe(true);
    expect(() => assertCredentialFreeEvidence({ nested: { token: 'fixture-secret' } }, 'fixture')).toThrow('credential-bearing keys');
    expect(() => assertCredentialFreeEvidence({ message: 'Bearer fixture-secret-value' }, 'fixture')).toThrow('bearer value');
  });

  it('requires a complete manifest/digest pair from flags or the formal environment', () => {
    expect(resolvePackageSubjectRequest(new Map(), {})).toBeUndefined();
    expect(resolvePackageSubjectRequest(new Map(), {
      AIMUSE_PACKAGE_SUBJECT_MANIFEST: SUBJECT_MANIFEST,
      AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: SUBJECT_DIGEST,
    })).toEqual({ manifestPath: SUBJECT_MANIFEST, expectedManifestSha256: SUBJECT_DIGEST });
    expect(() => resolvePackageSubjectRequest(new Map([['package-subject-manifest', SUBJECT_MANIFEST]]), {})).toThrow('requires both');
    expect(() => resolvePackageSubjectRequest(new Map([['package-subject-manifest-sha256', 'invalid']]), {})).toThrow('requires both');
  });

  it('binds the declared executable and retained evidence to the verified package subject', async () => {
    const request = { manifestPath: SUBJECT_MANIFEST, expectedManifestSha256: SUBJECT_DIGEST };
    const verifySubject = async () => ({
      manifestPath: SUBJECT_MANIFEST,
      manifestSha256: SUBJECT_DIGEST,
      manifest: { subject: { identitySha256: SUBJECT_IDENTITY, files: { applicationExecutable: { path: relative(resolve('.'), SUBJECT_EXE) } } } },
    });
    const binding = await verifyHeadlessPackageSubject({ exe: SUBJECT_EXE, request, verifySubject });
    expect(binding).toEqual({ manifestPath: SUBJECT_MANIFEST, manifestSha256: SUBJECT_DIGEST, subjectIdentitySha256: SUBJECT_IDENTITY });
    await expect(reverifyHeadlessPackageSubjectAtRestart({ exe: SUBJECT_EXE, request, before: binding, verifySubject })).resolves.toEqual(binding);
    await expect(reverifyHeadlessPackageSubjectAtRestart({
      exe: SUBJECT_EXE,
      request,
      before: binding,
      verifySubject: async () => ({
        manifestPath: SUBJECT_MANIFEST,
        manifestSha256: SUBJECT_DIGEST,
        manifest: { subject: { identitySha256: 'C'.repeat(64), files: { applicationExecutable: { path: relative(resolve('.'), SUBJECT_EXE) } } } },
      }),
    })).rejects.toThrow('does not match');
    expect(assertPackageSubjectEvidence(binding, binding)).toBe(true);
    expect(assertPackageSubjectEvidence(undefined, undefined)).toBe(true);
    await expect(verifyHeadlessPackageSubject({ exe: resolve('out', 'other', 'AIMuse'), request, verifySubject })).rejects.toThrow('does not match');
    expect(() => assertPackageSubjectEvidence({ ...binding, subjectIdentitySha256: 'C'.repeat(64) }, binding)).toThrow('does not match');
  });
});
