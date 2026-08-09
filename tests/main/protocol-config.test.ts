import { describe, expect, it } from 'vitest';
import { AIMUSE_PROTOCOL_SCHEME } from '../../src/main/protocol-config';

describe('custom media protocol', () => {
  it('declares streaming support required by Chromium audio elements', () => {
    expect(AIMUSE_PROTOCOL_SCHEME).toMatchObject({
      scheme: 'aimuse',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    });
  });
});
