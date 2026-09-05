import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeDialogDestination, nativeDialogDirectory, nativeDialogFilename } from '../../src/main/native-dialog-paths';

describe('native dialog session paths', () => {
  const currentRoot = join(process.cwd(), 'test-results', 'current-run', 'projects');
  const historicalRoot = join(process.cwd(), 'test-results', 'historical-run', 'projects');
  const documents = join(process.cwd(), 'Documents');

  it('uses the current launch trust instead of an unrelated historical directory', () => {
    const directory = nativeDialogDirectory({
      trustedFolders: [currentRoot],
      permittedRoots: [],
      fallbackDirectory: documents,
      currentDirectory: historicalRoot,
    });
    const destination = nativeDialogDestination({
      trustedFolders: [currentRoot],
      permittedRoots: [],
      fallbackDirectory: documents,
      currentDirectory: historicalRoot,
    }, 'QA L2 Export Subject Copy.aimuse');

    expect(directory).toBe(currentRoot);
    expect(destination).toBe(join(currentRoot, 'QA L2 Export Subject Copy.aimuse'));
    expect(destination.startsWith(historicalRoot)).toBe(false);
    expect(isAbsolute(destination)).toBe(true);
  });

  it('keeps a current project directory when it belongs to any current permitted root', () => {
    const projectDirectory = join(currentRoot, 'album');
    expect(nativeDialogDirectory({
      trustedFolders: [currentRoot],
      permittedRoots: [join(process.cwd(), 'other-output')],
      fallbackDirectory: documents,
      currentDirectory: projectDirectory,
    })).toBe(projectDirectory);
  });

  it('uses policy and ordinary interactive fallbacks without native panel history', () => {
    const policyRoot = join(process.cwd(), 'policy-output');
    expect(nativeDialogDirectory({ trustedFolders: [], permittedRoots: [policyRoot], fallbackDirectory: documents })).toBe(policyRoot);
    expect(nativeDialogDirectory({ trustedFolders: [], permittedRoots: [], fallbackDirectory: documents })).toBe(documents);
  });

  it('turns untrusted project names into a single safe filename', () => {
    const filename = nativeDialogFilename('../outside/project?.wav');
    const destination = nativeDialogDestination({ trustedFolders: [currentRoot], permittedRoots: [], fallbackDirectory: documents }, '../outside/project?.wav');
    expect(filename).toBe('..-outside-project-.wav');
    expect(dirname(destination)).toBe(currentRoot);
  });

  it('wires every native open and destination panel to an explicit session path', async () => {
    const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    expect(source.match(/dialog\.showSaveDialog/g)).toHaveLength(3);
    expect(source.match(/defaultPath: nativeDestinationDefault\(/g)).toHaveLength(3);
    expect(source.match(/dialog\.showOpenDialog/g)).toHaveLength(3);
    expect(source.match(/defaultPath: nativeDialogDirectory\('read'/g)).toHaveLength(3);
  });
});
