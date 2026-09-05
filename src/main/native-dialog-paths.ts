import { isAbsolute, join, relative, resolve } from 'node:path';

export interface NativeDialogPathOptions {
  trustedFolders: readonly string[];
  permittedRoots: readonly string[];
  fallbackDirectory: string;
  currentDirectory?: string;
}

function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function uniqueRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const root = resolve(path);
    const key = normalized(root);
    if (!seen.has(key)) { seen.add(key); roots.push(root); }
  }
  return roots;
}

/**
 * Returns an explicit absolute directory for a native file panel. Electron
 * otherwise lets macOS restore the directory used by an older app process,
 * which is not authority granted to the current session. This sets the
 * implicit location without preventing an explicit human choice in the panel.
 */
export function nativeDialogDirectory(options: NativeDialogPathOptions): string {
  const roots = uniqueRoots([...options.trustedFolders, ...options.permittedRoots]);
  const current = options.currentDirectory ? resolve(options.currentDirectory) : undefined;
  if (current && roots.some((root) => within(normalized(root), normalized(current)))) return current;
  return roots[0] ?? current ?? resolve(options.fallbackDirectory);
}

export function nativeDialogFilename(value: string): string {
  const cleaned = [...value]
    .map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character)
    .join('')
    .slice(0, 240)
    .replace(/[. ]+$/g, '');
  return cleaned || 'Untitled';
}

export function nativeDialogDestination(options: NativeDialogPathOptions, filename: string): string {
  return join(nativeDialogDirectory(options), nativeDialogFilename(filename));
}
