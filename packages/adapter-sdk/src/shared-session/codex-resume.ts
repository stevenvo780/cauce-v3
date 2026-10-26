import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import { readSessionsSecure } from '../sdk/durable-store/session-file.js';
import { AGENT_LANE_SUFFIX } from '../harnesses/shared/session-reservation.js';
import type { ResumeLaunchPlan } from './types.js';

interface Binding { stateDirectory: string; configDirectory: string; namespace: string; workspace: string }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const rolloutName = /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/u;
const MAX_TREE_ENTRIES = 20_000;

async function secureDirectory(path: string): Promise<boolean> {
  const info = await stat(path);
  return normalize(path) === path && await realpath(path) === path && info.isDirectory()
    && info.uid === process.geteuid?.() && (info.mode & 0o022) === 0;
}

export function codexSharedPointerKey(namespace: string): string {
  return `codex:${namespace}:shared:${namespace}`;
}

async function pointerOf(input: Binding): Promise<{ native_id: string; initialized: boolean } | undefined> {
  return (await readSessionsSecure(join(input.stateDirectory, 'sessions.json'))).sessions[codexSharedPointerKey(input.namespace)];
}

/** Rollout names of the tree, or undefined when it cannot be listed within bounds. A missing tree is empty. */
async function rolloutNames(configDirectory: string): Promise<readonly string[] | undefined> {
  try {
    const names = await readdir(join(configDirectory, 'sessions'), { recursive: true });
    return names.length > MAX_TREE_ENTRIES ? undefined : names.filter(name => name.endsWith('.jsonl'));
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? [] : undefined;
  }
}

/** A fresh launch requires both private directories, no pointer and no rollout at all. */
export async function codexConversationTreeIsEmpty(input: Binding): Promise<boolean> {
  try {
    if (!await secureDirectory(input.stateDirectory) || !await secureDirectory(input.configDirectory)) return false;
    if (await pointerOf(input) !== undefined) return false;
    return (await rolloutNames(input.configDirectory))?.length === 0;
  } catch {
    return false;
  }
}

/** The one private CLI rollout of `nativeId`, whose header names that id and the exact workspace; `pending` while its header is incomplete. */
async function rolloutAccreditation(input: Binding, nativeId: string): Promise<boolean | 'pending'> {
  const root = join(input.configDirectory, 'sessions');
  if (!await secureDirectory(root)) return false;
  const names = await readdir(root, { recursive: true });
  if (names.length > MAX_TREE_ENTRIES) return false;
  const candidates = names.filter(name => name.endsWith(`-${nativeId}.jsonl`));
  if (candidates.length !== 1 || candidates[0] === undefined) return false;
  const file = join(root, candidates[0]);
  if (await realpath(file) !== file || !await secureDirectory(dirname(file))) return false;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.nlink !== 1 || (info.mode & 0o022) !== 0) return false;
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return bytesRead < buffer.length ? 'pending' : false;
    const value: unknown = JSON.parse(text.slice(0, end));
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'session_meta'
        || !('payload' in value) || typeof value.payload !== 'object' || value.payload === null) return false;
    const meta = value.payload;
    return 'id' in meta && meta.id === nativeId && 'source' in meta && meta.source === 'cli'
      && 'cwd' in meta && meta.cwd === input.workspace;
  } finally { await handle.close(); }
}

export async function exactCodexLaunch(input: Binding, allowNew = false): Promise<ResumeLaunchPlan> {
  const blocked: ResumeLaunchPlan = { state: 'blocked', detail: 'No se acreditó la conversación exacta de Codex.' };
  if (!await secureDirectory(input.stateDirectory) || !await secureDirectory(input.configDirectory)) return blocked;
  const pointer = await pointerOf(input);
  if (pointer === undefined && allowNew) {
    return (await rolloutNames(input.configDirectory))?.length === 0 ? { state: 'launch', args: [], resumed: false } : blocked;
  }
  if (pointer?.initialized !== true || !uuid.test(pointer.native_id)) return blocked;
  return await rolloutAccreditation(input, pointer.native_id) === true
    ? { state: 'launch', args: ['resume', pointer.native_id], resumed: true } : blocked;
}

type SingleConversation = { readonly state: 'pending' | 'refused' } | { readonly state: 'created'; readonly nativeId: string };

/**
 * The tree's only conversation while no pointer names one: its single rollout, accredited exactly as a resume would be.
 * Several rollouts, a pointer already present or any unsafe metadata are refused; no rollout yet is pending.
 */
async function singleCodexConversation(input: Binding): Promise<SingleConversation> {
  try {
    if (!await secureDirectory(input.stateDirectory) || !await secureDirectory(input.configDirectory)) return { state: 'refused' };
    if (await pointerOf(input) !== undefined) return { state: 'refused' };
    const names = await rolloutNames(input.configDirectory);
    if (names?.length === 0) return { state: 'pending' };
    if (names?.length !== 1 || names[0] === undefined) return { state: 'refused' };
    const nativeId = rolloutName.exec(basename(names[0]))?.[1];
    const accredited = nativeId === undefined ? false : await rolloutAccreditation(input, nativeId);
    return nativeId !== undefined && accredited === true ? { state: 'created', nativeId } : { state: accredited === 'pending' ? 'pending' : 'refused' };
  } catch {
    return { state: 'refused' };
  }
}

/** The pointer counts only after it reads back as the exact resume of that same id. */
async function publishExactPointer(input: Binding, nativeId: string, publish: (nativeId: string) => Promise<boolean>): Promise<string | undefined> {
  if (!await publish(nativeId)) return undefined;
  const plan = await exactCodexLaunch(input).catch((): ResumeLaunchPlan => ({ state: 'blocked', detail: '' }));
  return plan.state === 'launch' && plan.resumed && plan.args[1] === nativeId ? nativeId : undefined;
}

/**
 * The conversation the agent already holds without a canonical pointer, such as the one it kept before the policy
 * enabled its shared TUI: the tree's single accredited rollout, provided no session of another person or scope names it.
 */
export async function unpointedCodexConversation(input: Binding): Promise<string | undefined> {
  const single = await singleCodexConversation(input);
  if (single.state !== 'created') return undefined;
  const canonical = codexSharedPointerKey(input.namespace);
  const sessions = (await readSessionsSecure(join(input.stateDirectory, 'sessions.json'))).sessions;
  return Object.entries(sessions).some(([key, record]) => record.native_id === single.nativeId
    && key !== canonical && key !== `${canonical}${AGENT_LANE_SUFFIX}`) ? undefined : single.nativeId;
}

/** Names that conversation as the canonical pointer before the TUI starts, so the launch resumes it exactly. */
export async function seedUnpointedCodexConversation(
  input: Binding,
  publish: (nativeId: string) => Promise<boolean>,
): Promise<string | undefined> {
  const nativeId = await unpointedCodexConversation(input).catch(() => undefined);
  return nativeId === undefined ? undefined : await publishExactPointer(input, nativeId, publish);
}

/** Publishes the conversation a TUI just created from an empty tree, waiting a bounded time for its rollout. */
export async function adoptCreatedCodexConversation(
  input: Binding,
  publish: (nativeId: string) => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
  attempts = 50,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts && signal?.aborted !== true; attempt += 1) {
    const created = await singleCodexConversation(input);
    if (created.state === 'refused') return undefined;
    if (created.state === 'created') return await publishExactPointer(input, created.nativeId, publish);
    if (attempt + 1 < attempts) await sleep(100);
  }
  return undefined;
}
