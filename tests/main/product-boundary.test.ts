import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const removedRuntimeFiles = [
  'src/common/generation.ts',
  'src/main/agent-client-config.ts',
  'src/main/credentials.ts',
  'src/main/generation-manager.ts',
  'src/main/macos-protected-storage.ts',
  'native/src/macos_protected_storage.mm',
  'scripts/build-macos-protected-storage.mjs',
  'scripts/macos-signing-policy.mjs',
  'scripts/macos-signing-policy.d.mts',
  'build/entitlements.mac.empty.plist',
] as const;

describe('native agent-driven DAW product boundary', () => {
  it('keeps provider, generation, client-config writer, and protected-storage implementations absent', async () => {
    for (const path of removedRuntimeFiles) await expect(access(resolve(path))).rejects.toThrow();
  });

  it('keeps retired product symbols out of runtime contracts and MCP authority', async () => {
    const [contracts, preload, main, mcp, authority] = await Promise.all([
      readFile(resolve('src/common/contracts.ts'), 'utf8'),
      readFile(resolve('src/preload/preload.ts'), 'utf8'),
      readFile(resolve('src/main/main.ts'), 'utf8'),
      readFile(resolve('src/main/mcp-host.ts'), 'utf8'),
      readFile(resolve('packages/core/src/authority.ts'), 'utf8'),
    ]);
    for (const source of [contracts, preload, main]) {
      expect(source).not.toMatch(/GenerationManager|CredentialStore|providerCapabilities|setProviderCredential|removeProviderCredential|candidateMediaUrl|provision-protected-storage|safeStorage/u);
    }
    expect(mcp).not.toMatch(/registerTool\(['"]generation_manage['"]/u);
    expect(authority).not.toMatch(/providerAllowlist|maxProviderRequests|maxGenerationRequests|spendingBudget/u);
    expect(contracts).not.toContain('getMcpConnection');
    expect(contracts).toContain('getAgentClientSettings');
    expect(main).toContain('bootstrapMcpBridgeEntry(applicationArguments, app)');
    expect(main).not.toContain("app.setPath('userData', bridgeEntry.electronUserDataPath)");
    expect(preload).not.toContain('mcp:connection');
  });

  it('keeps packages free of protected-secret authority while retaining ordinary signing', async () => {
    const [forge, packageSubject, verifyPackage, ...entitlements] = await Promise.all([
      readFile(resolve('forge.config.ts'), 'utf8'),
      readFile(resolve('scripts/package-subject.mjs'), 'utf8'),
      readFile(resolve('scripts/verify-package.mjs'), 'utf8'),
      ...[
        'build/entitlements.mac.plist',
        'build/entitlements.mac.inherit.plist',
        'build/entitlements.mac.development.plist',
        'build/entitlements.mac.development.inherit.plist',
      ].map((path) => readFile(resolve(path), 'utf8')),
    ]);
    expect(forge).toContain('[FuseV1Options.EnableCookieEncryption]: false');
    expect(packageSubject).toContain('[FuseV1Options.EnableCookieEncryption, FuseState.DISABLE]');
    expect(verifyPackage).toContain('[FuseV1Options.EnableCookieEncryption, FuseState.DISABLE]');
    for (const entitlement of entitlements) expect(entitlement).not.toMatch(/keychain-access-groups|application-identifier/u);
  });

  it('keeps release evidence production separate from caller-controlled acceptance', async () => {
    const [producer, workflow, witness, subjectVerifier, releaseVerifier, levelCertifier] = await Promise.all([
      readFile(resolve('scripts/package-subject.mjs'), 'utf8'),
      readFile(resolve('scripts/formal-package-workflow.mjs'), 'utf8'),
      readFile(resolve('scripts/release-command-witness.mjs'), 'utf8'),
      readFile(resolve('scripts/package-subject-verifier.mjs'), 'utf8'),
      readFile(resolve('scripts/release-evidence-verifier.mjs'), 'utf8'),
      readFile(resolve('scripts/release-level-certifier.mjs'), 'utf8'),
    ]);
    expect(producer).not.toContain('export async function verifyPackageSubject');
    expect(producer).not.toContain('verified: true');
    expect(producer).toContain("acceptanceVerdict: null");
    expect(workflow).not.toContain('formalAutomationPassed');
    // Keep this assertion text from being mistaken for an actual relative import by the portability scanner.
    expect(workflow).not.toContain("from " + "'./release-evidence-verifier.mjs'");
    expect(workflow).toContain("kind: 'aimuse-formal-release-automation-observations'");
    expect(witness).toContain("kind: 'aimuse-witnessed-command-execution'");
    expect(witness).toContain('termination: { exitCode: observed.exitCode, signal: observed.signal }');
    expect(subjectVerifier).toContain('Independent verification requires every manifest-authorized source input');
    expect(releaseVerifier).toContain('caller-controlled digest');
    expect(releaseVerifier).toContain("verdict: 'AUTOMATED_GATES_PASS'");
    expect(releaseVerifier).toContain("levelCertification: 'PENDING_INDEPENDENT_MCP_AND_COMPUTER_USE'");
    expect(levelCertifier).toContain("verdict: 'PASS'");
    expect(levelCertifier).toContain("tester?.role !== 'independent-tester'");
  });

  it('does not retain removed direct validation or config-writer dependencies', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies).not.toHaveProperty('ajv');
    expect(packageJson.dependencies).not.toHaveProperty('ajv-formats');
    expect(packageJson.dependencies).not.toHaveProperty('jsonc-parser');
    expect(packageJson.dependencies).toHaveProperty('@modelcontextprotocol/node');
    expect(packageJson.dependencies).toHaveProperty('hono');
  });
});
