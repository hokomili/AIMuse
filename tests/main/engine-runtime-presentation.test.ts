import { describe, expect, it } from 'vitest';
import { EngineRuntime } from '../../src/main/engine-runtime';

describe('engine presentation status', () => {
  it('reports current editor attachment instead of retaining the startup presentation mode', () => {
    const runtime = new EngineRuntime({
      userDataPath: '/private/tmp/aimuse-presentation-status-no-write',
      profileId: 'A'.repeat(64),
      appVersion: 'test',
      mode: 'interactive',
    });

    expect(runtime.status()).toMatchObject({ uiAttached: false, mode: 'headless' });
    runtime.setUiAttached(true);
    expect(runtime.status()).toMatchObject({ uiAttached: true, mode: 'interactive' });
    runtime.setUiAttached(false);
    expect(runtime.status()).toMatchObject({ uiAttached: false, mode: 'headless' });
  });
});
