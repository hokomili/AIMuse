import { describe, expect, it } from 'vitest';
import { unavailableMidiDiscovery, validateNativeMidiDiscovery } from '../../src/main/midi-discovery';

describe('native MIDI discovery contract', () => {
  it('keeps disconnected or malformed native reports unavailable without exposing partial ports', () => {
    expect(validateNativeMidiDiscovery(undefined)).toEqual(unavailableMidiDiscovery());
    expect(validateNativeMidiDiscovery({ backendConnected: true, generation: 1, ports: [{ id: '', direction: 'input' }] })).toEqual(unavailableMidiDiscovery());
    expect(validateNativeMidiDiscovery({ backendConnected: true, generation: 1, ports: [
      { id: 'winrt:opaque', direction: 'input' }, { id: 'winrt:opaque', direction: 'input' },
    ] })).toEqual(unavailableMidiDiscovery());
    expect(validateNativeMidiDiscovery({ backendConnected: false, generation: 2, ports: [{ id: 'stale', direction: 'output' }] })).toEqual(unavailableMidiDiscovery());
  });

  it('preserves backend identity and direction while retaining disconnect generation for stale-lease rejection', () => {
    const connected = validateNativeMidiDiscovery({ backendConnected: true, generation: 7, ports: [
      { id: 'winrt:opaque-endpoint', direction: 'input' },
      { id: 'winrt:opaque-endpoint', direction: 'output' },
    ] });
    expect(connected).toEqual({ backendConnected: true, generation: 7, ports: [
      { id: 'winrt:opaque-endpoint', direction: 'input' },
      { id: 'winrt:opaque-endpoint', direction: 'output' },
    ] });
    expect(validateNativeMidiDiscovery({ backendConnected: false, generation: 8, ports: [] })).toEqual({
      backendConnected: false, generation: 8, ports: [],
    });
  });
});
