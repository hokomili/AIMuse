import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { assertOwnerPrivateRoot, assertPrivateRootDeclaration, normalizePrivateRootIdentity } from './qa-private-root.mjs';

const HELP = `AIMuse QA MCP client

Usage:
  node scripts/qa-mcp.mjs init --private-root <dir> --connection <json> --state <json> --actor-name <name> --actor-color <#RRGGBB> [--model <name>] [--effort <name>] [--task-id <id>]
  node scripts/qa-mcp.mjs tool --private-root <dir> --state <json> --name <tool> [--args-file <json> | --args-json <json>]
  node scripts/qa-mcp.mjs resource --private-root <dir> --state <json> --uri <aimuse://...>
  node scripts/qa-mcp.mjs close --private-root <dir> --state <json>

The state file contains a localhost bearer token. Keep it below an existing
owner-private --private-root under ignored test-results/ and never paste it
into a report. Init and every follow-up verify the persisted root filesystem
identity before bearer reads, requests, or state writes.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv; const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]; if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('='); const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2); const value = separator >= 0 ? argument.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`); values.set(key, value);
  }
  return { command, values };
}
function required(values, key) { const value = values.get(key); if (!value) throw new Error(`--${key} is required.`); return value; }
function within(root, path) { const value = relative(root, path); return value === '' || (!value.startsWith('..') && !isAbsolute(value)); }
function assertEvidencePath(path) { const root = resolve('test-results'); if (!within(root, path)) throw new Error(`QA MCP state must stay below ${root}: ${path}`); }
function parseRpcPayload(text) {
  const trimmed = text.trim(); if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const events = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
  if (!events.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 240)}`); return JSON.parse(events.at(-1));
}
async function request(url, headers, body) {
  const response = await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: globalThis.AbortSignal.timeout(30_000) });
  const payload = parseRpcPayload(await response.text()); if (!response.ok || payload.error) throw new Error(JSON.stringify(payload.error ?? payload)); return { response, payload };
}
function baseHeaders(token) { return { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }; }
async function writeState(path, state) { await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
function assertPrivateStatePaths(statePath, privateRoot, connectionPath) {
  const evidenceRoot = resolve('test-results');
  if (privateRoot === evidenceRoot || !within(evidenceRoot, privateRoot)) throw new Error(`QA MCP private root must be a child below ${evidenceRoot}: ${privateRoot}`);
  for (const path of [statePath, connectionPath]) if (!within(privateRoot, path)) throw new Error(`QA MCP path must stay below persisted private root ${privateRoot}: ${path}`);
}
function normalizeOpenState(statePath, value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !value.url || !value.token || !value.sessionId || !Number.isInteger(value.nextRequestId) || typeof value.privateRoot !== 'string' || !isAbsolute(value.privateRoot) || typeof value.connectionPath !== 'string' || !isAbsolute(value.connectionPath)) throw new Error(`Invalid or closed QA MCP state: ${statePath}`);
  const privateRoot = resolve(value.privateRoot);
  const state = { ...value, privateRoot, privateRootIdentity: normalizePrivateRootIdentity(value.privateRootIdentity, 'QA MCP private root identity'), connectionPath: resolve(value.connectionPath) };
  assertPrivateStatePaths(statePath, privateRoot, state.connectionPath);
  return state;
}
function privateRootPlatform(dependencies) { return dependencies.platform ?? process.platform; }
async function observePrivateRoot(privateRoot, paths, dependencies, persisted) {
  const observed = await (dependencies.assertPrivateRoot ?? assertOwnerPrivateRoot)({ privateRoot, paths });
  if (persisted) assertPrivateRootDeclaration(privateRoot, persisted.privateRoot, persisted.privateRootIdentity, observed, privateRootPlatform(dependencies));
  else assertPrivateRootDeclaration(privateRoot, observed.root, observed.identity, observed, privateRootPlatform(dependencies));
  return observed;
}
async function revalidatePrivateContext(context, paths = context.paths) {
  if (context.privateRootFailure) throw context.privateRootFailure;
  try { return await observePrivateRoot(context.privateRoot, paths, context.dependencies, context.state); }
  catch (error) { context.privateRootFailure = error; throw error; }
}
async function loadState(values, dependencies = {}) {
  const privateRoot = resolve(required(values, 'private-root'));
  const statePath = resolve(required(values, 'state')); assertEvidencePath(statePath);
  const initial = await observePrivateRoot(privateRoot, [statePath], dependencies);
  const state = normalizeOpenState(statePath, JSON.parse(await (dependencies.readFile ?? readFile)(statePath, 'utf8')));
  assertPrivateRootDeclaration(privateRoot, state.privateRoot, state.privateRootIdentity, initial, privateRootPlatform(dependencies));
  const context = { privateRoot, statePath, state, paths: [statePath, state.connectionPath], dependencies };
  await revalidatePrivateContext(context);
  return context;
}
async function guardedWriteState(context, state) {
  await revalidatePrivateContext(context);
  return (context.dependencies.writeState ?? writeState)(context.statePath, state);
}
async function guardedOutput(context, value) {
  await revalidatePrivateContext(context);
  return (context.dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(value);
}
async function rpc(context, state, method, params = {}) {
  const id = state.nextRequestId; const headers = { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId };
  await revalidatePrivateContext(context);
  const result = await (context.dependencies.request ?? request)(state.url, headers, { jsonrpc: '2.0', id, method, params }); state.nextRequestId += 1; state.lastRequestAt = (context.dependencies.nowIso ?? (() => new Date().toISOString()))(); await guardedWriteState(context, state); return result.payload.result;
}
function structuredToolResult(result, name) {
  if (result?.isError) throw new Error(`${name} returned an MCP tool error: ${JSON.stringify(result)}`);
  const textEntry = result?.content?.find((entry) => entry.type === 'text' && typeof entry.text === 'string'); if (!textEntry) return result;
  try { return JSON.parse(textEntry.text); } catch { return { text: textEntry.text, raw: result }; }
}

export async function init(values, dependencies = {}) {
  const privateRoot = resolve(required(values, 'private-root')); const connectionPath = resolve(required(values, 'connection')); const statePath = resolve(required(values, 'state')); assertEvidencePath(connectionPath); assertEvidencePath(statePath);
  const actorName = required(values, 'actor-name'); const actorColor = required(values, 'actor-color');
  if (!/^#[0-9a-f]{6}$/i.test(actorColor)) throw new Error('--actor-color must be #RRGGBB.');
  const observedPrivateRoot = await observePrivateRoot(privateRoot, [connectionPath, statePath], dependencies);
  const privateRootIdentity = normalizePrivateRootIdentity(observedPrivateRoot.identity);
  const context = { privateRoot, statePath, state: { privateRoot, privateRootIdentity }, paths: [connectionPath, statePath], dependencies };
  const readText = dependencies.readFile ?? readFile;
  const requestRpc = dependencies.request ?? request;
  const fetchRequest = dependencies.fetch ?? globalThis.fetch;
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const connection = JSON.parse(await readText(connectionPath, 'utf8')); if (!connection.url || !connection.token || !connection.pid) throw new Error('The QA connection file is incomplete.');
  await revalidatePrivateContext(context);
  const initialized = await requestRpc(connection.url, baseHeaders(connection.token), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { resources: { subscribe: true } }, clientInfo: { name: 'AIMuse isolated QA', version: '1.0' } } });
  const sessionId = initialized.response.headers.get('mcp-session-id'); if (!sessionId) throw new Error('AIMuse did not return an MCP session ID.');
  const state = { version: 1, url: connection.url, token: connection.token, sessionId, nextRequestId: 2, privateRoot, privateRootIdentity, connectionPath, connectionPid: connection.pid, actorName, actorColor, initializedAt: nowIso() };
  context.state = state;
  await revalidatePrivateContext(context);
  await fetchRequest(state.url, { method: 'POST', headers: { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: globalThis.AbortSignal.timeout(10_000) });
  await guardedWriteState(context, state);
  const client = { product: 'AIMuse formal QA', version: '1.0', ...(values.get('model') ? { model: values.get('model') } : {}), ...(values.get('effort') ? { effort: values.get('effort') } : {}), ...(values.get('task-id') ? { taskId: values.get('task-id') } : {}) };
  const joined = structuredToolResult(await rpc(context, state, 'tools/call', { name: 'session_manage', arguments: { action: 'join', name: actorName, color: actorColor, client } }), 'session_manage');
  await guardedOutput(context, `${JSON.stringify({ statePath, url: state.url, connectionPid: state.connectionPid, actorName, joined }, null, 2)}\n`);
}
export async function tool(values, dependencies = {}) {
  const context = await loadState(values, dependencies); const { state } = context; const name = required(values, 'name'); const argsFile = values.get('args-file'); const argsJson = values.get('args-json');
  if (argsFile && argsJson) throw new Error('Use only one of --args-file or --args-json.');
  const args = argsFile ? JSON.parse(await (dependencies.readArgumentFile ?? readFile)(resolve(argsFile), 'utf8')) : argsJson ? JSON.parse(argsJson) : {};
  await guardedOutput(context, `${JSON.stringify(structuredToolResult(await rpc(context, state, 'tools/call', { name, arguments: args }), name), null, 2)}\n`);
}
export async function resource(values, dependencies = {}) {
  const context = await loadState(values, dependencies); const { state } = context; const uri = required(values, 'uri'); const result = await rpc(context, state, 'resources/read', { uri }); await guardedOutput(context, `${JSON.stringify(result, null, 2)}\n`);
}
export async function close(values, dependencies = {}) {
  const context = await loadState(values, dependencies); const { statePath, state } = context; let leave;
  try { leave = structuredToolResult(await rpc(context, state, 'tools/call', { name: 'session_manage', arguments: { action: 'leave' } }), 'session_manage'); }
  finally {
    await revalidatePrivateContext(context);
    const headers = { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId }; await (dependencies.fetch ?? globalThis.fetch)(state.url, { method: 'DELETE', headers, signal: globalThis.AbortSignal.timeout(10_000) }).catch(() => undefined);
    await guardedWriteState(context, { version: 1, url: state.url, privateRoot: state.privateRoot, privateRootIdentity: state.privateRootIdentity, connectionPath: state.connectionPath, connectionPid: state.connectionPid, actorName: state.actorName, actorColor: state.actorColor, initializedAt: state.initializedAt, closedAt: (dependencies.nowIso ?? (() => new Date().toISOString()))(), credentialsRedacted: true });
  }
  await guardedOutput(context, `${JSON.stringify({ statePath, left: true, result: leave }, null, 2)}\n`);
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) process.stdout.write(HELP);
  else if (command === 'init') await init(values);
  else if (command === 'tool') await tool(values);
  else if (command === 'resource') await resource(values);
  else if (command === 'close') await close(values);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
