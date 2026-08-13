export interface AudioTelemetryState {
  cpuLoad: number;
  xruns: number;
}

// Older native helpers omitted callback telemetry. A current helper must send
// the two related values together so corrupt protocol data cannot silently
// overwrite the host's last coherent observation.
export function reconcileNativeAudioTelemetry(
  current: AudioTelemetryState,
  native: { cpuLoad?: unknown; xruns?: unknown },
): AudioTelemetryState {
  const { cpuLoad, xruns } = native;
  if (cpuLoad === undefined && xruns === undefined) return current;
  if (typeof cpuLoad !== 'number' || !Number.isFinite(cpuLoad) || cpuLoad < 0) {
    throw new Error('Native audio service reported an invalid callback CPU load.');
  }
  if (typeof xruns !== 'number' || !Number.isSafeInteger(xruns) || xruns < 0) {
    throw new Error('Native audio service reported an invalid callback overrun count.');
  }
  return { cpuLoad, xruns };
}
