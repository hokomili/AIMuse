export interface RendererTrustFacts {
  windowPresent: boolean;
  senderMatchesWindow: boolean;
  frameMatchesMainFrame: boolean;
  frameUrl: string;
}

interface PreventableEvent {
  preventDefault(): void;
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasNoAuthorityCredentials(url: URL): boolean {
  return url.username === '' && url.password === '';
}

export function isTrustedRendererUrl(candidateValue: string, devServerValue?: string): boolean {
  const candidate = parseUrl(candidateValue);
  if (!candidate || !hasNoAuthorityCredentials(candidate)) return false;

  if (candidate.protocol === 'aimuse:' && candidate.hostname === 'app' && candidate.port === '') return true;

  const devServer = parseUrl(devServerValue);
  if (!devServer || !['http:', 'https:'].includes(devServer.protocol) || !hasNoAuthorityCredentials(devServer)) return false;
  return candidate.protocol === devServer.protocol && candidate.origin === devServer.origin;
}

export function assertTrustedRenderer(facts: RendererTrustFacts, devServerValue?: string): void {
  if (!facts.windowPresent || !facts.senderMatchesWindow || !facts.frameMatchesMainFrame) {
    throw new Error('Rejected IPC from an untrusted renderer.');
  }
  if (!isTrustedRendererUrl(facts.frameUrl, devServerValue)) {
    throw new Error('Rejected IPC from an unexpected origin.');
  }
}

export function guardRendererNavigation(event: PreventableEvent, targetUrl: string, devServerValue?: string): void {
  if (!isTrustedRendererUrl(targetUrl, devServerValue)) event.preventDefault();
}

export function denyWindowOpen(): { action: 'deny' } {
  return { action: 'deny' };
}

export function preventWebviewAttachment(event: PreventableEvent): void {
  event.preventDefault();
}

export function denyPermissionCheck(): boolean {
  return false;
}

export function denyPermissionRequest(
  _contents: unknown,
  _permission: string,
  callback: (permissionGranted: boolean) => void,
): void {
  callback(false);
}
