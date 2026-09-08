import { readFile } from 'node:fs/promises';
import type { AuthorityPolicy } from '@aimuse/core';

/** Decode launch-policy JSON; AuthorityManager.install validates the policy before use. */
export async function readAuthorityPolicyFile(path: string): Promise<AuthorityPolicy> {
  const text = await readFile(path, 'utf8');
  // Windows PowerShell can prefix UTF-8 output with EF BB BF. Remove only that
  // initial marker, preserving any U+FEFF characters inside policy values.
  const json = text.startsWith('\uFEFF') ? text.slice(1) : text;
  try {
    return JSON.parse(json) as AuthorityPolicy;
  } catch {
    throw new Error(`Authority policy file ${JSON.stringify(path)} is not valid JSON. Use UTF-8 JSON with an optional leading BOM.`);
  }
}
