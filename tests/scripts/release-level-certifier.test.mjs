import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { certifyReleaseLevel } from '../../scripts/release-level-certifier.mjs';

const roots = [];
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function writePrivate(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  return { bytes: Buffer.byteLength(bytes), sha256: sha256(Buffer.from(bytes)) };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aimuse-level-certifier-'));
  roots.push(workspace);
  const runRoot = join(workspace, 'test-results', 'luna-high', 'full-level2');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const contractBytes = await readFile(resolve('scripts/formal-release-contract.json'));
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const certifierSha256 = sha256(await readFile(resolve('scripts/release-level-certifier.mjs')));
  await writePrivate(join(workspace, 'scripts', 'formal-release-contract.json'), contractBytes);
  const paths = {
    inputs: join(runRoot, 'declared-release-inputs.json'),
    observations: join(runRoot, 'automation-observations.json'),
    automated: join(runRoot, 'independent-automated-verification.json'),
    certification: join(runRoot, 'independent-level2-certification.json'),
    report: join(runRoot, 'report.md'),
    evidence: join(runRoot, 'case-evidence.json'),
  };
  const inputs = {
    schemaVersion: 2,
    kind: 'aimuse-declared-release-inputs',
    level: 2,
    implementationTaskId: 'implementation-task',
    expectedIndependentTester: { model: 'gpt-5.6-luna', reasoningEffort: 'high', distinctTaskRequired: true },
    paths: { packageSubjectManifest: join(runRoot, 'package-subject.json') },
    contract: { path: 'scripts/formal-release-contract.json', bytes: contractBytes.length, sha256: sha256(contractBytes) },
    controls: { 'scripts/release-level-certifier.mjs': { sha256: certifierSha256 } },
  };
  const inputBytes = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
  await writePrivate(paths.inputs, inputBytes);
  const inputSha256 = sha256(inputBytes);
  const observations = await writePrivate(paths.observations, '{}\n');
  const automated = {
    schemaVersion: 2,
    reportKind: 'independently-derived-automated-release-verification',
    verdict: 'AUTOMATED_GATES_PASS',
    levelCertification: 'PENDING_INDEPENDENT_MCP_AND_COMPUTER_USE',
    eligibleForIndependentCertification: true,
    verifierSha256: '5'.repeat(64),
    witnessSha256: '6'.repeat(64),
    declaredInputsSha256: inputSha256,
    observationManifestSha256: observations.sha256,
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    package: {
      manifestSha256: '1'.repeat(64),
      subjectIdentitySha256: '2'.repeat(64),
      executableSha256: '3'.repeat(64),
      applicationAsarSha256: '4'.repeat(64),
      signature: 'ad-hoc',
      architecture: 'arm64',
    },
    execution: { independentlyAttributed: true, receipts: [] },
    checks: [],
    limitations: ['AUTOMATED_GATES_PASS is not a Level 2 PASS.', 'A full level result requires independent testing.', 'Ad-hoc limitation.'],
  };
  const automatedBytes = Buffer.from(`${JSON.stringify(automated, null, 2)}\n`);
  await writePrivate(paths.automated, automatedBytes);
  const automatedSha256 = sha256(automatedBytes);
  const reportBytes = Buffer.from('# Independent Level 2 report\n\nOverall: PASS\n');
  await writePrivate(paths.report, reportBytes);
  const reportSha256 = sha256(reportBytes);
  const evidenceBytes = Buffer.from('{"observed":true}\n');
  await writePrivate(paths.evidence, evidenceBytes);
  const evidence = { path: 'case-evidence.json', bytes: evidenceBytes.length, sha256: sha256(evidenceBytes) };
  const certification = {
    schemaVersion: 2,
    kind: 'aimuse-independent-level-certification',
    level: 2,
    overall: 'PASS',
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    tester: { role: 'independent-tester', taskId: 'tester-task', implementationTaskId: 'implementation-task', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
    interfaces: { sourceInspection: 'manifest-authorized-only', computerUse: 'native-computer-use', mcp: 'isolated-qa-mcp', playwrightSubstitute: false },
    subject: {
      declaredInputsSha256: inputSha256,
      automationObservationsSha256: observations.sha256,
      automatedVerificationSha256: automatedSha256,
      packageManifestSha256: automated.package.manifestSha256,
      subjectIdentitySha256: automated.package.subjectIdentitySha256,
      executableSha256: automated.package.executableSha256,
      applicationAsarSha256: automated.package.applicationAsarSha256,
    },
    report: { path: 'report.md', bytes: reportBytes.length, sha256: reportSha256 },
    cases: contract.certification['2'].requiredCaseIds.map((id) => ({ id, outcome: 'PASS', evidence: [evidence] })),
    findings: { BLOCKER: [], P0: [], P1: [], P2: [], P3: [] },
    coverageExceptions: [],
    cleanup: { credentialsRedacted: true, engineStopped: true, noRunOwnedProcessSurvived: true, packageReverifiedAfterStop: true, formalRootIdentityStable: true },
  };
  const writeCertification = async () => {
    const bytes = Buffer.from(`${JSON.stringify(certification, null, 2)}\n`);
    await writePrivate(paths.certification, bytes);
    return sha256(bytes);
  };
  await writePrivate(inputs.paths.packageSubjectManifest, '{}\n');
  const args = (certificationSha256) => ({
    workspace, formalRunRoot: runRoot, level: 2,
    observationManifestPath: paths.observations, expectedObservationManifestSha256: observations.sha256,
    declaredInputsPath: paths.inputs, expectedDeclaredInputsSha256: inputSha256,
    automatedVerificationPath: paths.automated, expectedAutomatedVerificationSha256: automatedSha256,
    certificationManifestPath: paths.certification, expectedCertificationManifestSha256: certificationSha256,
    reportPath: paths.report, expectedReportSha256: reportSha256,
    expectedEvidenceVerifierSha256: '5'.repeat(64), expectedWitnessSha256: '6'.repeat(64), expectedCertifierSha256: certifierSha256,
  });
  const dependencies = {
    verifyReleaseEvidence: async () => automated,
    verifyPackageSubject: async () => ({ manifest: { subject: { identitySha256: automated.package.subjectIdentitySha256 } } }),
  };
  return { certification, writeCertification, args, dependencies };
}

describe('final independent level certification', () => {
  it('derives Level 2 PASS only from the exact independent case set and final cleanup', async () => {
    const value = await fixture();
    const digest = await value.writeCertification();
    await expect(certifyReleaseLevel(value.args(digest), value.dependencies)).resolves.toMatchObject({
      verdict: 'PASS', level: 2, tester: { taskId: 'tester-task' }, evidence: { requiredCases: 23 },
    });
  });

  it('rejects same-task certification and any missing mandatory case', async () => {
    const value = await fixture();
    value.certification.tester.taskId = 'implementation-task';
    let digest = await value.writeCertification();
    await expect(certifyReleaseLevel(value.args(digest), value.dependencies)).rejects.toThrow(/not independent/u);

    value.certification.tester.taskId = 'tester-task';
    value.certification.cases.pop();
    digest = await value.writeCertification();
    await expect(certifyReleaseLevel(value.args(digest), value.dependencies)).rejects.toThrow(/exact ordered required case set/u);
  });
});
