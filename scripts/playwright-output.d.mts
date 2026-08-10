export const PACKAGED_E2E_OUTPUT_ENV: 'AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR';
export const FORMAL_RUN_ROOT_ENV: 'AIMUSE_FORMAL_RUN_ROOT';

export interface PackagedE2eOutputSelection {
  workspaceRoot: string;
  testResultsRoot: string;
  packagedOutputRoot: string;
  outputDir: string;
  htmlReportDir: string;
  formalRunRoot: string | undefined;
}

export function packagedE2ePathsOverlap(left: string, right: string, platform?: NodeJS.Platform): boolean;

export function resolvePackagedE2eOutputSelection(options?: {
  workspace?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): PackagedE2eOutputSelection;
