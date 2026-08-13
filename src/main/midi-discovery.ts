export type MidiPortDirection = 'input' | 'output';

export interface MidiPortDescriptor {
  // Opaque backend identity: never normalize it from a display name, position,
  // or prior scan. The same backend endpoint/direction must retain this value
  // while it remains connected.
  id: string;
  direction: MidiPortDirection;
}

export interface MidiDiscoveryStatus {
  backendConnected: boolean;
  generation: number;
  ports: MidiPortDescriptor[];
}

export const unavailableMidiDiscovery = (): MidiDiscoveryStatus => ({ backendConnected: false, generation: 0, ports: [] });

// A native report is visibility only. An invalid report is discarded as a
// whole rather than publishing a partial port list. This does not authorize
// endpoint opening, capture, sending, or recording.
export function validateNativeMidiDiscovery(value: unknown): MidiDiscoveryStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableMidiDiscovery();
  const report = value as { backendConnected?: unknown; generation?: unknown; ports?: unknown };
  const generation = report.generation;
  if (typeof report.backendConnected !== 'boolean' || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(report.ports)) return unavailableMidiDiscovery();
  const ports: MidiPortDescriptor[] = [];
  const identifiers = new Set<string>();
  for (const candidate of report.ports) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return unavailableMidiDiscovery();
    const port = candidate as { id?: unknown; direction?: unknown };
    if (typeof port.id !== 'string' || port.id.length === 0 || (port.direction !== 'input' && port.direction !== 'output')) return unavailableMidiDiscovery();
    const key = `${port.direction}\u0000${port.id}`;
    if (identifiers.has(key)) return unavailableMidiDiscovery();
    identifiers.add(key);
    ports.push({ id: port.id, direction: port.direction });
  }
  // A disconnected backend must not leave stale ports visible. Its generation
  // remains observable so a future endpoint opener can reject earlier leases.
  if (!report.backendConnected && ports.length > 0) return unavailableMidiDiscovery();
  return { backendConnected: report.backendConnected, generation, ports };
}
