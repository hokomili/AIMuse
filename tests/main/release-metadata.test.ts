import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('honest release metadata', () => {
  it('keeps workspace versions aligned and prevents a stable label while tracker gates remain open', async () => {
    const root = resolve('.');
    const application = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
    const core = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
    const tracker = await readFile(resolve(root, 'docs/FEATURE_TRACKER.md'), 'utf8');
    const readme = await readFile(resolve(root, 'README.md'), 'utf8');
    expect(application.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(core.version).toBe(application.version); expect(lock.version).toBe(application.version); expect(lock.packages['']?.version).toBe(application.version);
    expect(readme).toContain(`\`${application.version}\``); expect(tracker).toContain('This is the source of truth for implementation status.');
    const ids = [...tracker.matchAll(/^\| ([A-Z]{2,4}-\d{2}) \|/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(20); expect(new Set(ids).size).toBe(ids.length);
    const hasOpenSelectedV1Gate = /\| (?:🟡 Partial|🟠 Scaffolded|⬜ Missing) \| P[01] \|/.test(tracker);
    if (!application.version.includes('-')) expect(hasOpenSelectedV1Gate, 'Stable metadata requires every selected-v1 P0/P1 exit criterion to be closed.').toBe(false);
    else expect(application.version).not.toBe('1.0.0');
  });
});

