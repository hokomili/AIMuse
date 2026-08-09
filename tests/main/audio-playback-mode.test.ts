import { describe, expect, it } from 'vitest';
import { audioServiceArguments, validateNativePlaybackModeReport } from '../../src/main/audio-playback-mode';

describe('audio playback mode contract', () => {
  it('keeps shared output as the unchanged default and makes exclusive output explicit', () => {
    expect(audioServiceArguments('shared')).toEqual(['--stdio']);
    expect(audioServiceArguments('exclusive')).toEqual(['--stdio', '--playback-mode=exclusive']);
    expect(() => audioServiceArguments('automatic' as 'shared')).toThrow('Unsupported audio playback mode.');
  });

  it('accepts only truthful requested and effective WASAPI mode reports', () => {
    expect(validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: 'shared',
      effectivePlaybackMode: 'shared',
      realtimeBackendReady: true,
      driver: 'wasapi',
    })).toEqual({ requestedPlaybackMode: 'shared', effectivePlaybackMode: 'shared' });
    expect(validateNativePlaybackModeReport('exclusive', {
      requestedPlaybackMode: 'exclusive',
      effectivePlaybackMode: 'exclusive',
      realtimeBackendReady: true,
      driver: 'wasapi',
    })).toEqual({ requestedPlaybackMode: 'exclusive', effectivePlaybackMode: 'exclusive' });
    expect(validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: 'shared',
      effectivePlaybackMode: 'unavailable',
      realtimeBackendReady: false,
      driver: 'offline',
      diagnostic: 'WASAPI support is unavailable.',
    })).toEqual({ requestedPlaybackMode: 'shared', effectivePlaybackMode: 'unavailable' });
  });

  it('fails closed on exclusive unavailability, mismatch, fallback, or malformed diagnostics', () => {
    expect(() => validateNativePlaybackModeReport('exclusive', {
      requestedPlaybackMode: 'exclusive',
      effectivePlaybackMode: 'unavailable',
      realtimeBackendReady: false,
      driver: 'offline',
      diagnostic: 'Endpoint rejected exclusive initialization.',
    })).toThrow('WASAPI exclusive output was requested but is unavailable: Endpoint rejected exclusive initialization.');
    expect(() => validateNativePlaybackModeReport('exclusive', {
      requestedPlaybackMode: 'shared',
      effectivePlaybackMode: 'shared',
      realtimeBackendReady: true,
      driver: 'wasapi',
    })).toThrow('playback request mismatch');
    expect(() => validateNativePlaybackModeReport('exclusive', {
      requestedPlaybackMode: 'exclusive',
      effectivePlaybackMode: 'shared',
      realtimeBackendReady: true,
      driver: 'wasapi',
    })).toThrow('must not fall back');
    expect(() => validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: 'shared',
      effectivePlaybackMode: 'shared',
      realtimeBackendReady: false,
      driver: 'offline',
    })).toThrow('while its real-time backend was unavailable');
    expect(() => validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: undefined,
      effectivePlaybackMode: undefined,
      realtimeBackendReady: true,
      driver: 'wasapi',
    })).toThrow('valid requested playback mode');
  });

  it('accepts only truthful CoreAudio reports when the macOS driver contract is selected', () => {
    expect(validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: 'shared', effectivePlaybackMode: 'shared', realtimeBackendReady: true, driver: 'coreaudio',
    }, 'coreaudio')).toEqual({ requestedPlaybackMode: 'shared', effectivePlaybackMode: 'shared' });
    expect(() => validateNativePlaybackModeReport('exclusive', {
      requestedPlaybackMode: 'exclusive', effectivePlaybackMode: 'unavailable', realtimeBackendReady: false, driver: 'offline', diagnostic: 'device busy',
    }, 'coreaudio')).toThrow('CoreAudio exclusive output was requested but is unavailable: device busy');
    expect(() => validateNativePlaybackModeReport('shared', {
      requestedPlaybackMode: 'shared', effectivePlaybackMode: 'shared', realtimeBackendReady: true, driver: 'wasapi',
    }, 'coreaudio')).toThrow('reported wasapi for requested CoreAudio shared output');
  });
});
