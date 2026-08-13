import { describe, expect, it } from 'vitest';
import { reconcileNativeAudioTelemetry } from '../../src/main/audio-telemetry';

describe('native callback telemetry reconciliation', () => {
  const current = { cpuLoad: 0.25, xruns: 3 };

  it('adopts a coherent latest callback load and cumulative overrun count', () => {
    expect(reconcileNativeAudioTelemetry(current, { cpuLoad: 1.25, xruns: 4 })).toEqual({ cpuLoad: 1.25, xruns: 4 });
  });

  it('retains a legacy helper observation when both telemetry fields are absent', () => {
    expect(reconcileNativeAudioTelemetry(current, {})).toEqual(current);
  });

  it('fails closed when paired telemetry is missing or malformed', () => {
    for (const native of [
      { cpuLoad: 0.5 },
      { xruns: 2 },
      { cpuLoad: -0.1, xruns: 2 },
      { cpuLoad: Number.NaN, xruns: 2 },
      { cpuLoad: 0.5, xruns: 1.5 },
      { cpuLoad: 0.5, xruns: -1 },
    ]) expect(() => reconcileNativeAudioTelemetry(current, native)).toThrow(/invalid callback/);
  });
});
