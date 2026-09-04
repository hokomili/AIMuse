export type MacActivationPolicy = 'regular' | 'accessory' | 'prohibited';

export interface EarlyBackgroundPresentationApp {
  disableHardwareAcceleration(): void;
  setActivationPolicy(policy: MacActivationPolicy): void;
}

export interface EditorPresentationDependencies {
  platform?: NodeJS.Platform;
  setActivationPolicy(policy: MacActivationPolicy): void;
  hideDock(): void;
  showDock(): Promise<void>;
  revealEditor(): boolean;
  hasEditor(): boolean;
  canAttach(): boolean;
}

/**
 * Installs the no-renderer startup boundary before Electron becomes ready.
 * On macOS, `prohibited` is the invariant; hiding the Dock alone is racy and
 * still leaves an application eligible for ordinary OS activation.
 */
export function installEarlyBackgroundPresentation(
  backgroundOnly: boolean,
  app: EarlyBackgroundPresentationApp,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!backgroundOnly) return;
  app.disableHardwareAcceleration();
  if (platform === 'darwin') app.setActivationPolicy('prohibited');
}

/**
 * Serializes the persistent engine's macOS presentation state. An admitted
 * show request promotes before creating a window; losing the last editor
 * restores the prohibited background policy without ending the engine.
 */
export class EditorPresentationLifecycle {
  private operationTail = Promise.resolve();

  constructor(private readonly dependencies: EditorPresentationDependencies) {}

  show(attach: () => Promise<void>): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.dependencies.canAttach()) return false;
      await this.promote();
      if (!this.dependencies.canAttach()) {
        this.restoreBackgroundIfDetached();
        return false;
      }
      if (this.dependencies.revealEditor()) return true;
      try {
        await attach();
      } catch (error) {
        this.restoreBackgroundIfDetached();
        throw error;
      }
      const attached = this.dependencies.hasEditor();
      if (!attached) this.restoreBackgroundIfDetached();
      return attached;
    });
  }

  detached(): Promise<void> {
    return this.enqueue(async () => { this.restoreBackgroundIfDetached(); });
  }

  /**
   * A macOS reopen can transiently promote a packaged app before Electron
   * emits `activate`. Only a queued, admitted show operation may retain that
   * promotion; otherwise remove the Dock surface and prohibit activation
   * again. Serializing this behind show also prevents its own activation event
   * from racing the editor that is being attached.
   */
  activated(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.dependencies.revealEditor()) return true;
      this.restoreBackgroundIfDetached();
      return false;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async promote(): Promise<void> {
    if ((this.dependencies.platform ?? process.platform) !== 'darwin') return;
    this.dependencies.setActivationPolicy('regular');
    try { await this.dependencies.showDock(); }
    catch (error) {
      this.dependencies.setActivationPolicy('prohibited');
      throw error;
    }
  }

  private restoreBackgroundIfDetached(): void {
    if ((this.dependencies.platform ?? process.platform) === 'darwin' && !this.dependencies.hasEditor()) {
      this.dependencies.hideDock();
      this.dependencies.setActivationPolicy('prohibited');
    }
  }
}
