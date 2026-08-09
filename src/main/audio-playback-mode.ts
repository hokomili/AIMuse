import { nativeAudioBackendLabel, nativeAudioDriverForPlatform, type NativeAudioDriver } from './platform';

export type AudioPlaybackMode = 'shared' | 'exclusive';
export type EffectiveAudioPlaybackMode = AudioPlaybackMode | 'unavailable';

export interface NativePlaybackModeReport {
  requestedPlaybackMode?: unknown;
  effectivePlaybackMode?: unknown;
  realtimeBackendReady: boolean;
  driver: NativeAudioDriver;
  diagnostic?: string;
}

export interface ValidatedPlaybackModeReport {
  requestedPlaybackMode: AudioPlaybackMode;
  effectivePlaybackMode: EffectiveAudioPlaybackMode;
}

export function audioServiceArguments(requestedMode: AudioPlaybackMode): string[] {
  if (requestedMode === 'shared') return ['--stdio'];
  if (requestedMode === 'exclusive') return ['--stdio', '--playback-mode=exclusive'];
  throw new Error('Unsupported audio playback mode.');
}

export function validateNativePlaybackModeReport(
  requestedMode: AudioPlaybackMode,
  report: NativePlaybackModeReport,
  expectedDriver: NativeAudioDriver = nativeAudioDriverForPlatform(),
): ValidatedPlaybackModeReport {
  if (report.requestedPlaybackMode !== 'shared' && report.requestedPlaybackMode !== 'exclusive') {
    throw new Error('Native audio service did not report a valid requested playback mode.');
  }
  if (report.requestedPlaybackMode !== requestedMode) {
    throw new Error(`Native audio service playback request mismatch: requested ${requestedMode}, service reported ${report.requestedPlaybackMode}.`);
  }
  if (report.effectivePlaybackMode !== 'shared' && report.effectivePlaybackMode !== 'exclusive' && report.effectivePlaybackMode !== 'unavailable') {
    throw new Error('Native audio service did not report a valid effective playback mode.');
  }
  if (!report.realtimeBackendReady) {
    if (report.effectivePlaybackMode !== 'unavailable') {
      throw new Error(`Native audio service reported effective ${report.effectivePlaybackMode} output while its real-time backend was unavailable.`);
    }
    if (requestedMode === 'exclusive') {
      throw new Error(`${nativeAudioBackendLabel(expectedDriver === 'coreaudio' ? 'darwin' : expectedDriver === 'wasapi' ? 'win32' : process.platform)} exclusive output was requested but is unavailable: ${report.diagnostic ?? 'the native service did not provide a diagnostic.'}`);
    }
    return { requestedPlaybackMode: requestedMode, effectivePlaybackMode: 'unavailable' };
  }
  if (expectedDriver === 'offline' || report.driver !== expectedDriver) {
    const backend = expectedDriver === 'coreaudio' ? 'CoreAudio' : expectedDriver === 'wasapi' ? 'WASAPI' : 'native real-time';
    throw new Error(`Native audio service reported ${report.driver} for requested ${backend} ${requestedMode} output.`);
  }
  if (report.effectivePlaybackMode !== requestedMode) {
    throw new Error(`Native audio service must not fall back from requested ${requestedMode} output to effective ${report.effectivePlaybackMode} output.`);
  }
  return { requestedPlaybackMode: requestedMode, effectivePlaybackMode: requestedMode };
}
