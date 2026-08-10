import { describe, expect, it } from 'vitest';
import {
  createProbeWav,
  validateCoreAudioExclusiveHello,
  validateCoreAudioHello,
  validateSoakWindow,
  validateStableDeviceTelemetry,
} from '../../scripts/macos-coreaudio-smoke.mjs';

describe('macOS CoreAudio smoke contract', () => {
  it('creates one bounded non-silent float32 stereo probe', () => {
    const probe = createProbeWav(48_000, 180, 0.005);
    expect(probe).toMatchObject({ frames: 8_640, sampleRate: 48_000, durationMs: 180, peak: 0.005 });
    expect(probe.wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(probe.wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(probe.wav.readUInt16LE(20)).toBe(3);
    expect(probe.wav.readUInt16LE(22)).toBe(2);
    expect(probe.wav.length).toBe(44 + probe.frames * 8);
    expect(probe.wav.readFloatLE(52)).not.toBe(0);
  });

  it('accepts only a ready shared CoreAudio identity with the explicit feature', () => {
    const hello = {
      driver: 'coreaudio', realtimeBackendReady: true,
      requestedPlaybackMode: 'shared', effectivePlaybackMode: 'shared',
      features: ['managed-preview-playback', 'coreaudio-shared-playback'],
    };
    expect(validateCoreAudioHello(hello)).toBe(hello);
    expect(() => validateCoreAudioHello({ ...hello, driver: 'wasapi' })).toThrow('CoreAudio was not ready');
    expect(() => validateCoreAudioHello({ ...hello, effectivePlaybackMode: 'exclusive' })).toThrow('retain the requested shared playback mode');
    expect(() => validateCoreAudioHello({ ...hello, features: [] })).toThrow('was not declared');
  });

  it('accepts only the precise fail-closed CoreAudio exclusive non-feature', () => {
    const unavailable = {
      driver: 'offline', realtimeBackendReady: false,
      requestedPlaybackMode: 'exclusive', effectivePlaybackMode: 'unavailable',
      diagnostic: 'CoreAudio exclusive output is not implemented; no shared-mode fallback was attempted.',
    };
    expect(validateCoreAudioExclusiveHello(unavailable)).toBe(unavailable);
    expect(() => validateCoreAudioExclusiveHello({ ...unavailable, driver: 'coreaudio', realtimeBackendReady: true, effectivePlaybackMode: 'shared' })).toThrow('fail-closed unavailable shape');
    expect(() => validateCoreAudioExclusiveHello({ ...unavailable, diagnostic: 'CoreAudio shared output is ready.' })).toThrow('rejection was not precise');
  });

  it('requires advancing callback/render telemetry and a stable device during the bounded soak', () => {
    const baseline = {
      realtimeBackendReady: true, callbackCount: 10, callbackFrames: 2_560, renderedFrames: 0,
      deviceReroutes: 0, deviceInterruptions: 0, deviceUnexpectedStops: 0, deviceInterruptionActive: false,
    };
    const after = { ...baseline, callbackCount: 210, callbackFrames: 53_760, renderedFrames: 48_000, deviceReroutes: 1 };
    expect(validateSoakWindow(baseline, after, 24_000)).toMatchObject({
      callbackCount: 200, callbackFrames: 51_200, renderedFrames: 48_000,
      telemetry: { deviceReroutes: 1 },
    });
    expect(() => validateSoakWindow(baseline, { ...after, renderedFrames: 1_000 }, 24_000)).toThrow('rendered only 1000 frames');
    expect(() => validateStableDeviceTelemetry({ ...after, realtimeBackendReady: false, deviceUnexpectedStops: 1, deviceDiagnostic: 'device lost' }, 'loss')).toThrow('became unavailable');
    expect(() => validateStableDeviceTelemetry({ ...after, deviceInterruptions: 1 }, 'interruption')).toThrow('reported 1 interruption');
  });
});
