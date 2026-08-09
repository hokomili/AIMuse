import { describe, expect, it, vi } from 'vitest';
import {
  assertTrustedRenderer,
  denyPermissionCheck,
  denyPermissionRequest,
  denyWindowOpen,
  guardRendererNavigation,
  isTrustedRendererUrl,
  preventWebviewAttachment,
} from '../../src/main/renderer-security';

describe('renderer security policy', () => {
  it('accepts only the application host for the packaged custom scheme', () => {
    expect(isTrustedRendererUrl('aimuse://app/index.html')).toBe(true);
    expect(isTrustedRendererUrl('aimuse://app/project?id=1#timeline')).toBe(true);

    for (const url of [
      'aimuse://media/project/id/asset',
      'aimuse://app.evil.example/index.html',
      'aimuse://user@app/index.html',
      'aimuse://app:443/index.html',
      'https://app/index.html',
      'not a URL',
    ]) expect(isTrustedRendererUrl(url)).toBe(false);
  });

  it('compares development URLs by parsed origin instead of a bypassable string prefix', () => {
    const devServer = 'http://localhost:5173';
    expect(isTrustedRendererUrl('http://localhost:5173/src/renderer.tsx', devServer)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:51730/', devServer)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173@evil.example/', devServer)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost.evil.example:5173/', devServer)).toBe(false);
    expect(isTrustedRendererUrl('https://localhost:5173/', devServer)).toBe(false);
    expect(isTrustedRendererUrl('blob:http://localhost:5173/renderer', devServer)).toBe(false);
  });

  it('requires the exact window, main frame and trusted origin for IPC', () => {
    const trusted = {
      windowPresent: true,
      senderMatchesWindow: true,
      frameMatchesMainFrame: true,
      frameUrl: 'aimuse://app/index.html',
    };
    expect(() => assertTrustedRenderer(trusted)).not.toThrow();
    expect(() => assertTrustedRenderer({ ...trusted, senderMatchesWindow: false })).toThrow('untrusted renderer');
    expect(() => assertTrustedRenderer({ ...trusted, frameMatchesMainFrame: false })).toThrow('untrusted renderer');
    expect(() => assertTrustedRenderer({ ...trusted, frameUrl: 'https://evil.example/' })).toThrow('unexpected origin');
  });

  it('prevents untrusted navigation while leaving the exact renderer origin alone', () => {
    const trustedEvent = { preventDefault: vi.fn() };
    guardRendererNavigation(trustedEvent, 'aimuse://app/index.html');
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    guardRendererNavigation(externalEvent, 'https://evil.example/');
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies new windows and webview attachment', () => {
    expect(denyWindowOpen()).toEqual({ action: 'deny' });
    const event = { preventDefault: vi.fn() };
    preventWebviewAttachment(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies permission checks and requests without prompting', () => {
    expect(denyPermissionCheck()).toBe(false);
    const callback = vi.fn();
    denyPermissionRequest(undefined, 'microphone', callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(false);
  });
});
