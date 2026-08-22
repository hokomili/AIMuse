import { randomBytes } from 'node:crypto';

const MCP_TOKEN_BYTES = 32;
const MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type McpTokenSource = (size: number) => Buffer;

/** Creates authority that is valid only for the lifetime of one engine process. */
export function createEphemeralMcpToken(source: McpTokenSource = randomBytes): string {
  const bytes = source(MCP_TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== MCP_TOKEN_BYTES) throw new Error('MCP token source must return exactly 32 bytes.');
  const token = bytes.toString('base64url');
  if (!MCP_TOKEN_PATTERN.test(token)) throw new Error('MCP token source produced an invalid bearer token.');
  return token;
}

export function isEphemeralMcpToken(value: string): boolean {
  return MCP_TOKEN_PATTERN.test(value);
}
