import { describe, expect, it } from 'vitest';
import { auditPortablePaths, portablePathKey, relativeImportCandidates, validatePortableRelativePath } from '../../scripts/portability-lib.mjs';

describe('portable initial-snapshot path contract', () => {
  it('rejects case, Unicode, reserved-name and trailing-character collisions deterministically', () => {
    expect(auditPortablePaths(['src/Audio.ts', 'src/audio.ts'])).toContain('src/audio.ts: collides with src/Audio.ts after case/Unicode normalization');
    expect(auditPortablePaths(['docs/Cafe\u0301.md', 'docs/Café.md'])).toContain('docs/Café.md: collides with docs/Café.md after case/Unicode normalization');
    expect(validatePortableRelativePath('src/CON.ts')).toContain('segment "CON.ts" is a Windows reserved name');
    expect(validatePortableRelativePath('src/name.')).toContain('segment "name." ends in a dot or space');
    expect(portablePathKey('Src\\É.ts')).toBe('src/é.ts');
  });

  it('resolves only explicit repository-relative import candidates', () => {
    expect(relativeImportCandidates('src/main/main.ts', './profile-identity')).toContain('src/main/profile-identity.ts');
    expect(relativeImportCandidates('src/main/main.ts', '../common/audio-protocol.js')).toContain('src/common/audio-protocol.ts');
    expect(validatePortableRelativePath('../outside.ts')).toContain('path must be a non-empty repository-relative path');
  });
});
