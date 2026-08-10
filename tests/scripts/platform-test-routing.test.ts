import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WINDOWS_SEALED_TESTS, platformTestExcludes } from '../../vitest.config.js';

describe('ordinary platform test routing', () => {
  it('retains the complete unchanged suite on Windows', () => {
    expect(platformTestExcludes('win32')).toEqual([]);
  });

  it('excludes only the exact sealed Windows/coordinator partition on Darwin', async () => {
    expect(platformTestExcludes('darwin')).toEqual([...WINDOWS_SEALED_TESTS]);
    expect(new Set(WINDOWS_SEALED_TESTS).size).toBe(WINDOWS_SEALED_TESTS.length);
    await expect(Promise.all(WINDOWS_SEALED_TESTS.map((path) => access(resolve(path))))).resolves.toBeDefined();
  });
});
