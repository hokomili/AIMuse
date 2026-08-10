import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS engine quit confirmation', () => {
  it('confirms editor-initiated quit while keeping instance-bound headless quit non-interactive', async () => {
    const source = await readFile(resolve('src/main/main.ts'), 'utf8');
    expect(source).toContain("confirmInEditor && process.platform === 'darwin'");
    expect(source).toContain("title: 'Quit AIMuse Engine'");
    expect(source).toContain("buttons: ['Quit Engine', 'Cancel'], defaultId: 1, cancelId: 1");
    expect(source).toContain('requestQuit(false)');
  });
});
