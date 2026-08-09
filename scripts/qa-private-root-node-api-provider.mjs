import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function loadAddon(addonPath, dependencies) {
  if (typeof addonPath !== 'string' || !isAbsolute(addonPath)) throw new Error('The private-root Node-API addon path must be absolute.');
  const normalized = resolve(addonPath);
  const access = dependencies.access ?? ((path) => accessSync(path, constants.R_OK));
  const load = dependencies.load ?? ((path) => require(path));
  access(normalized);
  const addon = load(normalized);
  return { addon, normalized };
}

export function loadPrivateRootNodeApiProvider(addonPath, dependencies = {}) {
  const { addon, normalized } = loadAddon(addonPath, dependencies);
  if (!addon || addon.providerVersion !== 2 || typeof addon.acquireLease !== 'function') throw new Error('The private-root Node-API addon does not expose the approved safe version 2 provider.');
  return Object.freeze({
    version: 2,
    addonPath: normalized,
    acquireLease: async (options) => addon.acquireLease(options),
  });
}

export function loadPrivateRootNodeApiRenameDiagnostics(addonPath, dependencies = {}) {
  const { addon, normalized } = loadAddon(addonPath, dependencies);
  if (!addon || addon.providerVersion !== 2 || typeof addon.runRenameDiagnostics !== 'function') {
    throw new Error('The private-root Node-API addon does not expose the approved safe version 2 rename diagnostic surface.');
  }
  return Object.freeze({
    version: 2,
    addonPath: normalized,
    run: async (options) => addon.runRenameDiagnostics(options),
  });
}

export function loadPrivateRootNodeApiReplacementIdentityDiagnostics(addonPath, dependencies = {}) {
  const { addon, normalized } = loadAddon(addonPath, dependencies);
  if (!addon || addon.providerVersion !== 2 || typeof addon.runReplacementIdentityDiagnostics !== 'function') {
    throw new Error('The private-root Node-API addon does not expose the approved safe version 2 replacement identity diagnostic surface.');
  }
  return Object.freeze({
    version: 2,
    addonPath: normalized,
    run: async (options) => addon.runReplacementIdentityDiagnostics(options),
  });
}
