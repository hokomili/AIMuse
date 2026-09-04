import { describe, expect, it, vi } from 'vitest';
import { EditorPresentationLifecycle, installEarlyBackgroundPresentation } from '../../src/main/editor-presentation-lifecycle';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function lifecycleHarness(platform: NodeJS.Platform = 'darwin') {
  const events: string[] = [];
  let attached = false;
  let allowed = true;
  const lifecycle = new EditorPresentationLifecycle({
    platform,
    setActivationPolicy: (policy) => { events.push(`policy-${policy}`); },
    hideDock: () => { events.push('dock-hide'); },
    showDock: async () => { events.push('dock-show'); },
    revealEditor: () => {
      if (!attached) return false;
      events.push('editor-reveal');
      return true;
    },
    hasEditor: () => attached,
    canAttach: () => allowed,
  });
  return {
    events,
    lifecycle,
    attach: () => { attached = true; events.push('editor-attach'); },
    detach: () => { attached = false; events.push('editor-detach'); },
    setAllowed: (value: boolean) => { allowed = value; },
  };
}

describe('persistent editor presentation lifecycle', () => {
  it('installs prohibited macOS background policy before readiness without relying on Dock hiding', () => {
    const events: string[] = [];
    const app = {
      disableHardwareAcceleration: () => { events.push('hardware-disabled'); },
      setActivationPolicy: (policy: string) => { events.push(`policy-${policy}`); },
    } as Parameters<typeof installEarlyBackgroundPresentation>[1];

    installEarlyBackgroundPresentation(true, app, 'darwin');
    expect(events).toEqual(['hardware-disabled', 'policy-prohibited']);

    events.length = 0;
    installEarlyBackgroundPresentation(false, app, 'darwin');
    expect(events).toEqual([]);
  });

  it('promotes before attaching one editor and restores prohibited mode after detach', async () => {
    const harness = lifecycleHarness();
    await expect(harness.lifecycle.show(async () => { harness.attach(); })).resolves.toBe(true);
    expect(harness.events).toEqual(['policy-regular', 'dock-show', 'editor-attach']);

    harness.detach();
    await harness.lifecycle.detached();
    expect(harness.events).toEqual([
      'policy-regular', 'dock-show', 'editor-attach',
      'editor-detach', 'dock-hide', 'policy-prohibited',
    ]);
  });

  it('returns to prohibited mode when promotion or editor attachment fails', async () => {
    const policyEvents: string[] = [];
    const dockFailure = new EditorPresentationLifecycle({
      platform: 'darwin',
      setActivationPolicy: (policy) => { policyEvents.push(policy); },
      hideDock: () => { policyEvents.push('dock-hidden'); },
      showDock: async () => { throw new Error('Dock unavailable'); },
      revealEditor: () => false,
      hasEditor: () => false,
      canAttach: () => true,
    });
    await expect(dockFailure.show(async () => undefined)).rejects.toThrow('Dock unavailable');
    expect(policyEvents).toEqual(['regular', 'prohibited']);

    const harness = lifecycleHarness();
    await expect(harness.lifecycle.show(async () => { throw new Error('renderer load failed'); })).rejects.toThrow('renderer load failed');
    expect(harness.events).toEqual(['policy-regular', 'dock-show', 'dock-hide', 'policy-prohibited']);
  });

  it('serializes detach with a following intentional show so the final editor stays foreground', async () => {
    const harness = lifecycleHarness();
    await harness.lifecycle.show(async () => { harness.attach(); });
    harness.detach();
    const detaching = harness.lifecycle.detached();
    const showing = harness.lifecycle.show(async () => { harness.attach(); });

    await expect(Promise.all([detaching, showing])).resolves.toEqual([undefined, true]);
    expect(harness.events.slice(-5)).toEqual(['dock-hide', 'policy-prohibited', 'policy-regular', 'dock-show', 'editor-attach']);
  });

  it('serializes an in-flight attach and reuses the one resulting editor', async () => {
    const harness = lifecycleHarness();
    const release = deferred();
    const first = harness.lifecycle.show(async () => { await release.promise; harness.attach(); });
    const secondAttach = vi.fn(async () => { harness.attach(); });
    const second = harness.lifecycle.show(secondAttach);

    await Promise.resolve();
    expect(harness.events).toEqual(['policy-regular', 'dock-show']);
    expect(secondAttach).not.toHaveBeenCalled();
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(secondAttach).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event === 'editor-attach')).toHaveLength(1);
    expect(harness.events.at(-1)).toBe('editor-reveal');
  });

  it('does not promote after terminal shutdown admission closes and is inert off macOS', async () => {
    const blocked = lifecycleHarness();
    blocked.setAllowed(false);
    await expect(blocked.lifecycle.show(async () => { blocked.attach(); })).resolves.toBe(false);
    expect(blocked.events).toEqual([]);

    const linux = lifecycleHarness('linux');
    await expect(linux.lifecycle.show(async () => { linux.attach(); })).resolves.toBe(true);
    linux.detach();
    await linux.lifecycle.detached();
    expect(linux.events).toEqual(['editor-attach', 'editor-detach']);
  });

  it('re-prohibits an ordinary activation without an editor and preserves an admitted show race', async () => {
    const background = lifecycleHarness();
    await expect(background.lifecycle.activated()).resolves.toBe(false);
    expect(background.events).toEqual(['dock-hide', 'policy-prohibited']);

    const attaching = lifecycleHarness();
    const release = deferred();
    const show = attaching.lifecycle.show(async () => { await release.promise; attaching.attach(); });
    const activation = attaching.lifecycle.activated();
    await Promise.resolve();
    expect(attaching.events).toEqual(['policy-regular', 'dock-show']);
    release.resolve();
    await expect(Promise.all([show, activation])).resolves.toEqual([true, true]);
    expect(attaching.events.at(-1)).toBe('editor-reveal');
    expect(attaching.events).not.toContain('dock-hide');
  });
});
