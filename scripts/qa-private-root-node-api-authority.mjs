import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { assertOwnerPrivateRoot } from './qa-private-root.mjs';

function samePath(left, right, platform) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return platform === 'win32'
    ? leftPath.toUpperCase() === rightPath.toUpperCase()
    : leftPath === rightPath;
}

export function createProviderCheckpointAuthority(runRootValue, dependencies = {}) {
  if (typeof runRootValue !== 'string' || !isAbsolute(runRootValue)) {
    throw new Error('Provider checkpoint authority requires one explicit absolute run root.');
  }
  const platform = dependencies.platform ?? process.platform;
  const runRoot = resolve(runRootValue);
  const assertRoot = dependencies.assertRoot ?? assertOwnerPrivateRoot;
  if (typeof assertRoot !== 'function') throw new Error('Provider checkpoint authority requires one private-root verifier.');

  const assertPrivateRoot = async (options) => {
    if (!options || typeof options !== 'object' || typeof options.privateRoot !== 'string' ||
        !isAbsolute(options.privateRoot) || !Array.isArray(options.paths) ||
        options.paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
      throw new Error('Provider checkpoint private-root verification requires explicit absolute root and paths.');
    }
    if (options.evidenceRoot !== undefined &&
        (typeof options.evidenceRoot !== 'string' || !isAbsolute(options.evidenceRoot) || !samePath(options.evidenceRoot, runRoot, platform))) {
      throw new Error('Provider checkpoint authority cannot be overridden or broadened.');
    }
    return await assertRoot({
      privateRoot: options.privateRoot,
      paths: options.paths,
      evidenceRoot: runRoot,
    });
  };

  return Object.freeze({
    version: 1,
    runRoot,
    assertPrivateRoot,
  });
}
