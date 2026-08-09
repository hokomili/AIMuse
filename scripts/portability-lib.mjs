import { posix } from 'node:path';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"|?*]/u;

export function portablePathKey(value) {
  return value.replaceAll('\\', '/').normalize('NFC').toLocaleLowerCase('en-US');
}

export function validatePortableRelativePath(value) {
  const normalized = value.replaceAll('\\', '/');
  const failures = [];
  if (!normalized || posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    failures.push('path must be a non-empty repository-relative path');
    return failures;
  }
  if (normalized.length > 240) failures.push('path exceeds the conservative 240-character transfer limit');
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') failures.push('path contains an empty or relative segment');
    if (segment.endsWith('.') || segment.endsWith(' ')) failures.push(`segment "${segment}" ends in a dot or space`);
    if (WINDOWS_RESERVED_NAME.test(segment)) failures.push(`segment "${segment}" is a Windows reserved name`);
    if (WINDOWS_INVALID_CHARACTER.test(segment) || [...segment].some((character) => character.charCodeAt(0) < 32)) {
      failures.push(`segment "${segment}" contains a non-portable character`);
    }
  }
  return failures;
}

export function auditPortablePaths(paths) {
  const failures = [];
  const owners = new Map();
  for (const path of paths) {
    for (const reason of validatePortableRelativePath(path)) failures.push(`${path}: ${reason}`);
    const key = portablePathKey(path);
    const existing = owners.get(key);
    if (existing && existing !== path) failures.push(`${path}: collides with ${existing} after case/Unicode normalization`);
    else owners.set(key, path);
  }
  return failures;
}

export function relativeImportCandidates(importer, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = [base];
  if (/\.[cm]?jsx?$/u.test(base)) {
    if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else if (!posix.extname(base)) {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`);
  }
  return [...new Set(candidates)];
}
