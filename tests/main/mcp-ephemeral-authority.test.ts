import { describe, expect, it } from 'vitest';
import { createEphemeralMcpToken, isEphemeralMcpToken } from '../../src/main/mcp-ephemeral-authority';

describe('ephemeral MCP authority', () => {
  it('derives one canonical bearer token from exactly 32 in-memory bytes', () => {
    const calls: number[] = [];
    const token = createEphemeralMcpToken((size) => { calls.push(size); return Buffer.alloc(size, 0xa5); });
    expect(calls).toEqual([32]);
    expect(token).toBe('paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU');
    expect(isEphemeralMcpToken(token)).toBe(true);
  });

  it('rejects malformed sources and produces independent engine tokens', () => {
    expect(() => createEphemeralMcpToken(() => Buffer.alloc(31))).toThrow(/exactly 32 bytes/u);
    const first = createEphemeralMcpToken();
    const second = createEphemeralMcpToken();
    expect(first).not.toBe(second);
    expect(isEphemeralMcpToken(first)).toBe(true);
    expect(isEphemeralMcpToken('persisted-secret')).toBe(false);
  });
});
