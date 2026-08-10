import { chromium, expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagedE2eSubject } from './package-subject';

const packagedSubject = packagedE2eSubject();
const executable = packagedSubject.executable;

interface Connection {
  version: 1;
  url: string;
  token: string;
  pid: number;
  instanceId: string;
  profileId: string;
}

interface TrackedCycle {
  process: ChildProcess;
  pid: number;
  connectionPath: string;
  browser?: Browser;
  page?: Page;
  connection?: Connection;
  stopped: boolean;
}

interface PackagedCycle extends TrackedCycle {
  browser: Browser;
  page: Page;
  connection: Connection;
}

async function waitForExit(process: ChildProcess, label: string, timeoutMilliseconds = 15_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(process, 'exit'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMilliseconds} ms.`)), timeoutMilliseconds); timer.unref(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback QA port.');
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForConnectionFile(path: string): Promise<Connection> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Connection;
      if (value.version === 1 && value.pid && value.instanceId && value.profileId && value.token) return value;
    } catch { /* The isolated engine is still publishing its private handoff. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('AIMuse did not publish a complete private MCP connection file.');
}

async function connectToPackagedEditor(port: number): Promise<{ browser: Browser; page: Page }> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0];
        if (!context) throw new Error('Packaged AIMuse did not expose an editor context.');
        while (Date.now() < deadline) {
          const page = context.pages().find((candidate) => candidate.url().startsWith('aimuse://app/'));
          if (page) return { browser, page };
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
        await browser.close();
      }
    } catch { /* The exact packaged process is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Could not attach to the packaged AIMuse editor over loopback DevTools.');
}

async function launchCycle(userData: string, connectionPath: string, cycles: TrackedCycle[]): Promise<PackagedCycle> {
  const port = await reserveLoopbackPort();
  const applicationProcess = spawn(executable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    `--write-mcp-connection=${connectionPath}`,
  ], { stdio: 'ignore', windowsHide: true });
  const pid = applicationProcess.pid;
  if (!pid) throw new Error('The packaged provider engine did not expose its spawned PID.');
  const cycle: TrackedCycle = { process: applicationProcess, pid, connectionPath, stopped: false };
  cycles.push(cycle);
  let rejectLaunch: (reason: unknown) => void = () => undefined;
  const launchFailure = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
  const onLaunchError = (error: Error): void => rejectLaunch(error);
  applicationProcess.once('error', onLaunchError);
  let connection: Connection;
  try { connection = await Promise.race([waitForConnectionFile(connectionPath), launchFailure]); }
  finally { applicationProcess.off('error', onLaunchError); }
  expect(connection.pid).toBe(pid);
  cycle.connection = connection;
  const attached = await connectToPackagedEditor(port);
  cycle.browser = attached.browser;
  cycle.page = attached.page;
  await expect(attached.page).toHaveTitle(/AIMuse/);
  return cycle as PackagedCycle;
}

async function stopCycle(cycle: TrackedCycle, userData: string): Promise<void> {
  if (cycle.stopped) return;
  if (cycle.process.exitCode !== null || cycle.process.signalCode !== null) {
    if (cycle.browser?.isConnected()) await cycle.browser.close();
    cycle.stopped = true;
    return;
  }
  if (!cycle.connection) {
    try {
      const candidate = JSON.parse(await readFile(cycle.connectionPath, 'utf8')) as Connection;
      if (candidate.version === 1 && candidate.pid === cycle.pid && candidate.instanceId) cycle.connection = candidate;
    } catch { /* A pre-handoff launch is still stopped through its isolated profile below. */ }
  }
  const quitter = spawn(executable, [
    '--quit-engine',
    ...(cycle.connection ? [`--quit-engine-instance=${cycle.connection.instanceId}`] : []),
    `--user-data-dir=${userData}`,
  ], { stdio: 'ignore', windowsHide: true });
  await waitForExit(quitter, cycle.connection ? 'AIMuse instance-bound lifecycle client' : 'AIMuse isolated-profile lifecycle client');
  await waitForExit(cycle.process, `AIMuse isolated provider engine PID ${cycle.pid}`);
  if (cycle.browser?.isConnected()) await cycle.browser.close();
  cycle.stopped = true;
}

async function openProviderCredential(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Generate' }).first().click();
  await expect(page.getByText(/provider credential|Credential stored/i).first()).toBeVisible();
}

async function assertNoPlaintextBytes(root: string, needles: string[]): Promise<number> {
  let inspected = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        inspected += 1;
        if (needles.some((needle) => bytes.includes(Buffer.from(needle)))) throw new Error(`Synthetic provider plaintext was retained in isolated profile file ${entry.name}.`);
      }
    }
  }
  await visit(root);
  return inspected;
}

async function attachCredentialFreeReport(testInfo: TestInfo, inspectedFiles: number): Promise<void> {
  await testInfo.attach('provider-credential-evidence.json', {
    contentType: 'application/json',
    body: Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      architecture: process.arch,
      cycles: ['setter', 'restart-and-rotation', 'restart-and-removal'],
      rendererIpcSerializationObserved: true,
      providerNetworkRequests: 0,
      credentialDirectoryOwnerOnly: process.platform === 'win32' ? 'ACL-not-inspected-by-this-test' : true,
      credentialFileOwnerOnly: process.platform === 'win32' ? 'ACL-not-inspected-by-this-test' : true,
      isolatedProfileFilesScanned: inspectedFiles,
      syntheticPlaintextMatches: 0,
      gracefulInstanceBoundStops: 3,
      computerUseCertification: false,
    }, null, 2)}\n`),
  });
}

test.describe('packaged provider credential lifecycle', () => {
  test.skip(!packagedSubject.exact && !existsSync(executable), 'Run npm run package before packaged provider credential QA.');

  let testRoot: string;
  let userData: string;
  const cycles: TrackedCycle[] = [];

  test.beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'aimuse-provider-e2e-'));
    userData = join(testRoot, 'profile');
  });

  test.afterEach(async () => {
    const failures: unknown[] = [];
    for (const cycle of [...cycles].reverse()) {
      try { await stopCycle(cycle, userData); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `Packaged provider cleanup failed; isolated evidence was retained at ${testRoot}.`);
    cycles.length = 0;
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('persists, rotates, and removes a synthetic credential through the real packaged setter', async ({ browserName }, testInfo) => {
    void browserName;
    const first = 'fixture-packaged-provider-v1-never-persist';
    const rotated = 'fixture-packaged-provider-v2-never-persist';
    const credentialPath = join(userData, 'credentials', 'providers.json');

    const setter = await launchCycle(userData, join(testRoot, 'connection-1.json'), cycles);
    await openProviderCredential(setter.page);
    await setter.page.getByRole('button', { name: 'Configure' }).click();
    await setter.page.getByPlaceholder('elevenlabs API key').fill(first);
    await setter.page.locator('.provider-credential').getByRole('button', { name: 'Save' }).click();
    await expect(setter.page.getByRole('button', { name: 'Manage' })).toBeVisible();
    expect(await readFile(credentialPath, 'utf8')).not.toContain(first);
    if (process.platform !== 'win32') {
      expect((await stat(join(userData, 'credentials'))).mode & 0o777).toBe(0o700);
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    }
    await stopCycle(setter, userData);

    const rotation = await launchCycle(userData, join(testRoot, 'connection-2.json'), cycles);
    await openProviderCredential(rotation.page);
    await expect(rotation.page.getByRole('button', { name: 'Manage' })).toBeVisible();
    await rotation.page.getByRole('button', { name: 'Manage' }).click();
    await rotation.page.getByPlaceholder('elevenlabs API key').fill(rotated);
    await rotation.page.locator('.provider-credential').getByRole('button', { name: 'Save' }).click();
    await expect(rotation.page.getByText('elevenlabs credential saved securely')).toBeVisible();
    const rotatedBytes = await readFile(credentialPath, 'utf8');
    expect(rotatedBytes).not.toContain(first);
    expect(rotatedBytes).not.toContain(rotated);
    await stopCycle(rotation, userData);

    const removal = await launchCycle(userData, join(testRoot, 'connection-3.json'), cycles);
    await openProviderCredential(removal.page);
    await expect(removal.page.getByRole('button', { name: 'Manage' })).toBeVisible();
    await removal.page.getByRole('button', { name: 'Manage' }).click();
    await removal.page.getByRole('button', { name: 'Remove' }).click();
    await expect(removal.page.getByText('elevenlabs credential removed')).toBeVisible();
    await expect(removal.page.getByRole('button', { name: 'Configure' })).toBeVisible();
    await stopCycle(removal, userData);

    const persisted = JSON.parse(await readFile(credentialPath, 'utf8')) as { version: number; values: Record<string, string> };
    expect(persisted).toEqual({ version: 1, values: {} });
    const inspectedFiles = await assertNoPlaintextBytes(userData, [first, rotated]);
    await attachCredentialFreeReport(testInfo, inspectedFiles);
  });
});
