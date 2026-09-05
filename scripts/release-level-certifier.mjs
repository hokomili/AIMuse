import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { verifyReleaseEvidence } from './release-evidence-verifier.mjs';
import { verifyPackageSubject } from './package-subject-verifier.mjs';

const INDEPENDENT_CERTIFICATION_FIELDS = ['schemaVersion', 'kind', 'level', 'overall', 'startedAt', 'finishedAt', 'tester', 'interfaces', 'subject', 'report', 'cases', 'findings', 'coverageExceptions', 'cleanup'];
const FINAL_VERIFICATION_FIELDS = ['schemaVersion', 'reportKind', 'verdict', 'level', 'certifierSha256', 'tester', 'source', 'package', 'evidence', 'limitations'];

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[A-F\d]{64}$/iu.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value.toUpperCase();
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function relativeEvidencePath(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split(/[\\/]/u).includes('..')) throw new Error(`Invalid certification evidence path: ${String(value)}`);
  const path = resolve(root, value);
  if (!strictChild(root, path)) throw new Error(`Certification evidence escaped the protected run root: ${value}`);
  return path;
}
async function assertOwnerPrivateFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${label} is not owned by the verifier user.`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible.`);
  }
  return info;
}
async function readBoundFile(path, digest, label) {
  await assertOwnerPrivateFile(path, label);
  const bytes = await readFile(path);
  if (sha256Bytes(bytes) !== assertSha256(digest, `${label} digest`)) throw new Error(`${label} bytes drifted.`);
  return bytes;
}
async function publishExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite final level verification: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}
function parseCli(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return values;
}
function required(values, key) { const value = values.get(key); if (!value) throw new Error(`--${key} is required.`); return value; }
function exactCaseIds(contract, level) {
  const values = contract?.certification?.[String(level)]?.requiredCaseIds;
  if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length) throw new Error(`Formal release contract has no stable Level ${level} case set.`);
  return values;
}
function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value ?? {}).sort();
  if (stableStringify(keys) !== stableStringify([...expected].sort())) throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`);
}

export async function certifyReleaseLevel({
  workspace = process.cwd(), formalRunRoot, level,
  observationManifestPath, expectedObservationManifestSha256,
  declaredInputsPath, expectedDeclaredInputsSha256,
  automatedVerificationPath, expectedAutomatedVerificationSha256,
  certificationManifestPath, expectedCertificationManifestSha256,
  reportPath, expectedReportSha256,
  expectedEvidenceVerifierSha256, expectedWitnessSha256, expectedCertifierSha256,
} = {}, dependencies = {}) {
  if (level !== 1 && level !== 2) throw new Error('Final release certification supports Level 1 or Level 2.');
  const root = resolve(workspace);
  const runRoot = resolve(formalRunRoot ?? '');
  const paths = {
    observations: resolve(observationManifestPath ?? ''),
    inputs: resolve(declaredInputsPath ?? ''),
    automated: resolve(automatedVerificationPath ?? ''),
    certification: resolve(certificationManifestPath ?? ''),
    report: resolve(reportPath ?? ''),
  };
  if (!formalRunRoot || Object.values(paths).some((path) => !strictChild(runRoot, path))) throw new Error('Every final certification input must be a strict child of the formal run root.');
  const certifierPath = fileURLToPath(import.meta.url);
  const certifierSha256 = await sha256File(certifierPath);
  if (certifierSha256 !== assertSha256(expectedCertifierSha256, 'Expected final certifier digest')) throw new Error('The caller-pinned final certifier bytes do not match.');
  const [inputBytes, automatedBytes, certificationBytes, reportBytes] = await Promise.all([
    readBoundFile(paths.inputs, expectedDeclaredInputsSha256, 'Declared release inputs'),
    readBoundFile(paths.automated, expectedAutomatedVerificationSha256, 'Independent automated verification'),
    readBoundFile(paths.certification, expectedCertificationManifestSha256, 'Independent tester certification'),
    readBoundFile(paths.report, expectedReportSha256, 'Independent tester report'),
  ]);
  const inputs = JSON.parse(inputBytes.toString('utf8'));
  const automated = JSON.parse(automatedBytes.toString('utf8'));
  const certification = JSON.parse(certificationBytes.toString('utf8'));
  if (inputs.level !== level || automated.schemaVersion !== 2 || automated.verdict !== 'AUTOMATED_GATES_PASS' || automated.levelCertification !== 'PENDING_INDEPENDENT_MCP_AND_COMPUTER_USE') throw new Error('Automated evidence is not an eligible pending Level certification subject.');
  if (inputs.controls?.['scripts/release-level-certifier.mjs']?.sha256 !== certifierSha256) throw new Error('Caller-pinned final certifier does not match the declared release controls.');
  const verifyAutomated = dependencies.verifyReleaseEvidence ?? verifyReleaseEvidence;
  const independentlyDerived = await verifyAutomated({
    workspace: root,
    formalRunRoot: runRoot,
    observationManifestPath: paths.observations,
    expectedObservationManifestSha256,
    declaredInputsPath: paths.inputs,
    expectedDeclaredInputsSha256,
    expectedVerifierSha256: expectedEvidenceVerifierSha256,
    expectedWitnessSha256,
  });
  if (stableStringify(independentlyDerived) !== stableStringify(automated)) throw new Error('Saved automated verification does not equal a fresh independent derivation.');
  if (certification?.schemaVersion !== 2 || certification.kind !== 'aimuse-independent-level-certification' || certification.level !== level || certification.overall !== 'PASS') throw new Error('Independent tester certification schema or disposition is invalid.');
  assertExactKeys(certification, INDEPENDENT_CERTIFICATION_FIELDS, 'Independent tester certification');
  const startedAt = Date.parse(certification.startedAt);
  const finishedAt = Date.parse(certification.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) throw new Error('Independent tester certification timestamps are invalid.');
  const tester = certification.tester;
  assertExactKeys(tester, ['role', 'taskId', 'implementationTaskId', 'model', 'reasoningEffort'], 'Tester attribution');
  if (tester?.role !== 'independent-tester' || typeof tester.taskId !== 'string' || !tester.taskId || tester.taskId === inputs.implementationTaskId || tester.implementationTaskId !== inputs.implementationTaskId || tester.model !== inputs.expectedIndependentTester.model || tester.reasoningEffort !== inputs.expectedIndependentTester.reasoningEffort) throw new Error('Tester attribution is absent, mismatched, or not independent from implementation.');
  assertExactKeys(certification.interfaces, ['sourceInspection', 'computerUse', 'mcp', 'playwrightSubstitute'], 'Certification interfaces');
  if (certification.interfaces.sourceInspection !== 'manifest-authorized-only' || certification.interfaces.computerUse !== 'native-computer-use' || certification.interfaces.mcp !== 'isolated-qa-mcp' || certification.interfaces.playwrightSubstitute !== false) throw new Error('Independent certification did not use the mandatory manifest/MCP/Computer Use interfaces.');
  const expectedSubject = {
    declaredInputsSha256: assertSha256(expectedDeclaredInputsSha256, 'Declared input digest'),
    automationObservationsSha256: assertSha256(expectedObservationManifestSha256, 'Automation observation digest'),
    automatedVerificationSha256: assertSha256(expectedAutomatedVerificationSha256, 'Automated verification digest'),
    packageManifestSha256: automated.package.manifestSha256,
    subjectIdentitySha256: automated.package.subjectIdentitySha256,
    executableSha256: automated.package.executableSha256,
    applicationAsarSha256: automated.package.applicationAsarSha256,
  };
  assertExactKeys(certification.subject, Object.keys(expectedSubject), 'Certification subject');
  if (stableStringify(certification.subject) !== stableStringify(expectedSubject)) throw new Error('Independent tester certification does not bind the exact automated package subject.');
  assertExactKeys(certification.report, ['path', 'bytes', 'sha256'], 'Certification report');
  if (certification.report?.path !== relative(runRoot, paths.report).split(sep).join('/') || certification.report?.sha256 !== assertSha256(expectedReportSha256, 'Tester report digest') || certification.report?.bytes !== reportBytes.length) throw new Error('Independent certification report binding drifted.');
  const contractBytes = await readFile(resolve(root, inputs.contract.path));
  if (contractBytes.length !== inputs.contract.bytes || sha256Bytes(contractBytes) !== assertSha256(inputs.contract.sha256, 'Formal release contract digest')) throw new Error('Formal release contract drifted during final certification.');
  const contract = JSON.parse(contractBytes.toString('utf8'));
  if (stableStringify(contract.schemaFields?.independentCertification) !== stableStringify(INDEPENDENT_CERTIFICATION_FIELDS) || stableStringify(contract.schemaFields?.finalVerification) !== stableStringify(FINAL_VERIFICATION_FIELDS)) throw new Error('Formal release contract fields disagree with the final certifier schema.');
  assertExactKeys(automated, contract.schemaFields.automatedVerification, 'Independent automated verification');
  const requiredCases = exactCaseIds(contract, level);
  if (!Array.isArray(certification.cases) || certification.cases.length !== requiredCases.length || stableStringify(certification.cases.map((entry) => entry.id)) !== stableStringify(requiredCases)) throw new Error('Independent tester certification does not contain the exact ordered required case set.');
  const evidenceDigests = [];
  for (const entry of certification.cases) {
    assertExactKeys(entry, ['id', 'outcome', 'evidence'], `Certification case ${entry.id ?? '<missing>'}`);
    if (entry.outcome !== 'PASS' || !Array.isArray(entry.evidence) || entry.evidence.length === 0) throw new Error(`Required certification case is not supported by passing evidence: ${entry.id}`);
    for (const declaration of entry.evidence) {
      assertExactKeys(declaration, ['path', 'bytes', 'sha256'], `Certification evidence ${entry.id}`);
      const path = relativeEvidencePath(runRoot, declaration.path);
      const bytes = await readBoundFile(path, declaration.sha256, `Certification evidence ${entry.id}`);
      if (declaration.bytes !== bytes.length) throw new Error(`Certification evidence size drifted for ${entry.id}.`);
      evidenceDigests.push({ caseId: entry.id, path: declaration.path, sha256: declaration.sha256 });
    }
  }
  assertExactKeys(certification.findings, ['BLOCKER', 'P0', 'P1', 'P2', 'P3'], 'Certification findings');
  if (Object.values(certification.findings).some((value) => !Array.isArray(value))) throw new Error('Certification finding severities must be arrays.');
  if (certification.findings.BLOCKER.length || certification.findings.P0.length) throw new Error('Level certification contains a Blocker or P0 finding.');
  if (!Array.isArray(certification.coverageExceptions) || certification.coverageExceptions.length !== 0) throw new Error('Level certification contains an unexplained mandatory coverage exception.');
  assertExactKeys(certification.cleanup, ['credentialsRedacted', 'engineStopped', 'noRunOwnedProcessSurvived', 'packageReverifiedAfterStop', 'formalRootIdentityStable'], 'Certification cleanup');
  if (Object.values(certification.cleanup).some((value) => value !== true)) throw new Error('Independent tester cleanup or final package re-verification is incomplete.');
  const packageManifestPath = resolve(inputs.paths.packageSubjectManifest);
  const finalPackage = await (dependencies.verifyPackageSubject ?? verifyPackageSubject)({
    workspace: root,
    manifestPath: packageManifestPath,
    expectedManifestSha256: automated.package.manifestSha256,
    formalRunRoot: runRoot,
    platform: process.platform,
    toolchain: inputs.toolchain?.externalTools,
    executionEnvironment: inputs.executionEnvironment,
  });
  if (finalPackage.manifest.subject.identitySha256 !== automated.package.subjectIdentitySha256) throw new Error('Package subject drifted after independent tester cleanup.');
  const result = {
    schemaVersion: 2,
    reportKind: 'independently-derived-full-level-verification',
    verdict: 'PASS',
    level,
    certifierSha256,
    tester: { taskId: tester.taskId, model: tester.model, reasoningEffort: tester.reasoningEffort },
    source: automated.source,
    package: automated.package,
    evidence: {
      declaredInputsSha256: expectedSubject.declaredInputsSha256,
      automationObservationsSha256: expectedSubject.automationObservationsSha256,
      automatedVerificationSha256: expectedSubject.automatedVerificationSha256,
      certificationManifestSha256: assertSha256(expectedCertificationManifestSha256, 'Certification manifest digest'),
      reportSha256: assertSha256(expectedReportSha256, 'Report digest'),
      requiredCases: requiredCases.length,
      evidenceBindings: evidenceDigests.length,
    },
    limitations: automated.limitations.filter((value) => !value.startsWith('AUTOMATED_GATES_PASS') && !value.startsWith('A full level result')),
  };
  assertExactKeys(result, contract.schemaFields.finalVerification, 'Final Level verification');
  return result;
}

async function main() {
  const values = parseCli(process.argv.slice(2));
  const runRoot = required(values, 'formal-run-root');
  const outputPath = resolve(required(values, 'output'));
  if (!strictChild(resolve(runRoot), outputPath)) throw new Error('Final verification output must be a strict child of the formal run root.');
  const report = await certifyReleaseLevel({
    workspace: values.get('workspace') || process.cwd(),
    formalRunRoot: runRoot,
    level: Number(required(values, 'level')),
    observationManifestPath: required(values, 'observations'),
    expectedObservationManifestSha256: required(values, 'expected-observations-sha256'),
    declaredInputsPath: required(values, 'declared-inputs'),
    expectedDeclaredInputsSha256: required(values, 'expected-declared-inputs-sha256'),
    automatedVerificationPath: required(values, 'automated-verification'),
    expectedAutomatedVerificationSha256: required(values, 'expected-automated-verification-sha256'),
    certificationManifestPath: required(values, 'certification'),
    expectedCertificationManifestSha256: required(values, 'expected-certification-sha256'),
    reportPath: required(values, 'report'),
    expectedReportSha256: required(values, 'expected-report-sha256'),
    expectedEvidenceVerifierSha256: required(values, 'expected-evidence-verifier-sha256'),
    expectedWitnessSha256: required(values, 'expected-witness-sha256'),
    expectedCertifierSha256: required(values, 'expected-certifier-sha256'),
  });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const artifact = await publishExclusive(outputPath, bytes);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 2, kind: 'aimuse-full-level-verification-reference', verdict: 'PASS', level: report.level, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse final level certification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
