import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';

export const PACKAGED_E2E_OUTPUT_ENV = 'AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR';
export const FORMAL_RUN_ROOT_ENV = 'AIMUSE_FORMAL_RUN_ROOT';

function pathKey(path, platform) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const normalized = pathApi.resolve(path).normalize('NFC');
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left, right, platform) {
  return pathKey(left, platform) === pathKey(right, platform);
}

function strictDescendant(parent, candidate, platform) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const difference = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(difference) && !samePath(parent, candidate, platform);
}

export function packagedE2ePathsOverlap(left, right, platform = process.platform) {
  return samePath(left, right, platform) || strictDescendant(left, right, platform) || strictDescendant(right, left, platform);
}

function nearestExistingPath(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`No existing ancestor is available for ${path}.`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return { existing: cursor, missingSegments };
}

function assertCanonicalPath(path, label, platform) {
  const absolute = resolve(path);
  const { existing, missingSegments } = nearestExistingPath(absolute);
  const existingInfo = lstatSync(existing);
  if (existingInfo.isSymbolicLink()) throw new Error(`${label} resolves through a symbolic link: ${existing}.`);
  const canonical = resolve(realpathSync.native(existing), ...missingSegments);
  if (!samePath(canonical, absolute, platform)) {
    throw new Error(`${label} must use its canonical path; ${absolute} resolves as ${canonical}.`);
  }

  let cursor = existing;
  while (true) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} resolves through a symbolic link: ${cursor}.`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

function absoluteEnvironmentPath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty absolute path when set.`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

/**
 * Select the only directories Playwright may clean or replace for packaged E2E.
 * The HTML reporter is deliberately nested below outputDir so it has no second,
 * ambient repository-level cleanup target.
 */
export function resolvePackagedE2eOutputSelection({
  workspace = process.cwd(),
  environment = process.env,
  platform = process.platform,
} = {}) {
  const workspaceRoot = assertCanonicalPath(resolve(workspace), 'AIMuse workspace', platform);
  const testResultsRoot = assertCanonicalPath(join(workspaceRoot, 'test-results'), 'AIMuse test-results root', platform);
  const packagedOutputRoot = assertCanonicalPath(join(testResultsRoot, 'playwright'), 'Packaged E2E output root', platform);
  const configuredOutput = environment[PACKAGED_E2E_OUTPUT_ENV];
  const outputDir = assertCanonicalPath(
    configuredOutput === undefined
      ? join(packagedOutputRoot, 'packaged-e2e')
      : absoluteEnvironmentPath(configuredOutput, PACKAGED_E2E_OUTPUT_ENV),
    'Packaged E2E output directory',
    platform,
  );

  if (!strictDescendant(packagedOutputRoot, outputDir, platform)) {
    throw new Error(`Packaged E2E output must be a strict descendant of ${packagedOutputRoot}; received ${outputDir}.`);
  }
  const htmlReportDir = assertCanonicalPath(`${outputDir}-html-report`, 'Packaged E2E HTML report directory', platform);
  if (!strictDescendant(packagedOutputRoot, htmlReportDir, platform)) {
    throw new Error(`Packaged E2E HTML report must be a strict descendant of ${packagedOutputRoot}; received ${htmlReportDir}.`);
  }

  const broadTargets = [
    ['repository root', workspaceRoot],
    ['repository test-results root', testResultsRoot],
    ['packaged E2E output root', packagedOutputRoot],
  ];
  for (const [label, path] of broadTargets) {
    if (samePath(outputDir, path, platform)) throw new Error(`Packaged E2E output must not equal the ${label}: ${path}.`);
  }

  const formalRunValue = environment[FORMAL_RUN_ROOT_ENV];
  let formalRunRoot;
  if (formalRunValue !== undefined) {
    formalRunRoot = assertCanonicalPath(
      absoluteEnvironmentPath(formalRunValue, FORMAL_RUN_ROOT_ENV),
      'Formal run root',
      platform,
    );
    const formalRunParent = dirname(formalRunRoot);
    for (const [label, protectedPath] of [['formal run root', formalRunRoot], ['formal run-root parent', formalRunParent]]) {
      if (packagedE2ePathsOverlap(outputDir, protectedPath, platform) || packagedE2ePathsOverlap(htmlReportDir, protectedPath, platform)) {
        throw new Error(`Packaged E2E output and HTML report must be disjoint from the declared ${label}: ${protectedPath}.`);
      }
    }
  }

  return {
    workspaceRoot,
    testResultsRoot,
    packagedOutputRoot,
    outputDir,
    htmlReportDir,
    formalRunRoot,
  };
}
