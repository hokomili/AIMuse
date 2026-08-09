import type { CustomScheme } from 'electron';

export const AIMUSE_PROTOCOL_SCHEME = {
  scheme: 'aimuse',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    // Electron requires this for HTML audio/video elements to consume a
    // Response body without treating the custom scheme as fully buffered.
    stream: true,
  },
} satisfies CustomScheme;
