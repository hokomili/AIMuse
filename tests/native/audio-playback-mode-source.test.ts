import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const playbackSource = readFileSync(fileURLToPath(new URL('../../native/src/realtime_playback.cpp', import.meta.url)), 'utf8');
const serviceSource = readFileSync(fileURLToPath(new URL('../../native/src/audio_service.cpp', import.meta.url)), 'utf8');
const optionSource = readFileSync(fileURLToPath(new URL('../../native/src/audio_service_options.hpp', import.meta.url)), 'utf8');

describe('native audio playback mode source contract', () => {
  it('maps the immutable request directly to one miniaudio share mode without a shared fallback', () => {
    expect(playbackSource).toContain(
      'config.playback.shareMode = requested_mode == PlaybackMode::exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;',
    );
    expect(playbackSource).not.toContain('config.playback.shareMode = ma_share_mode_shared;');
    expect(playbackSource).toContain('effective_mode = requested_mode;');
    expect(playbackSource).toContain('effective_mode.reset();');
  });

  it('defaults to shared and publishes requested/effective diagnostics through the service protocol', () => {
    expect(optionSource).toContain('PlaybackMode playback_mode{PlaybackMode::shared};');
    expect(optionSource).toContain('playback_mode_prefix = "--playback-mode="');
    expect(serviceSource).toContain('RealtimePlayback playback(parsed_options.options.playback_mode);');
    expect(serviceSource).toContain('requestedPlaybackMode');
    expect(serviceSource).toContain('effectivePlaybackMode');
    expect(serviceSource).toContain('wasapi-exclusive-opt-in');
  });
});
