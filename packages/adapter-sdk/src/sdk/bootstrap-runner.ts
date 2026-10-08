import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { BootstrapDescriptor, BootstrapProfile, BootstrapProof, BootstrapTransport } from './bootstrap-client.js';
import { measureBootstrapProfile } from './bootstrap-profile.js';
import type { CommandRunner, HarnessCommandOverride, HarnessDefinition } from './types.js';
import type { CommandPins } from './command-pins.js';
import { invocationDigest, projectSelectionArguments, selectionForProfile, type ExecutionSelection } from './execution-selection.js';

export interface BootstrapRunnerOptions {
  operation_id: string; phase: 'bootstrap' | 'normal'; runtime_key: string; tenant_id: string; alias: string;
  client: BootstrapTransport; definition: HarnessDefinition; runner: CommandRunner; commandOverride?: HarnessCommandOverride;
  commandPins?: CommandPins; executionSelection?: ExecutionSelection; onSelection?: (selection: ExecutionSelection) => void;
  profile?: typeof measureBootstrapProfile;
  pause?: (signal: AbortSignal) => Promise<void>;
}
function assertProfile(probe: BootstrapDescriptor, profile: BootstrapProfile): void {
  for (const key of ['operation_id', 'phase', 'runtime_key', 'tenant_id', 'alias', 'harness_id', 'model_id', 'account_id', 'profile_revision'] as const) {
    if (probe[key] !== profile[key]) throw new Error('bootstrap profile changed');
  }
  if ((probe.reasoning_effort ?? null) !== (profile.reasoning_effort ?? null)) throw new Error('bootstrap reasoning effort changed');
}
export async function runBootstrap(options: BootstrapRunnerOptions, signal: AbortSignal): Promise<boolean> {
  const pause = options.pause ?? (async (shutdown: AbortSignal) => { await setTimeout(500, undefined, { signal: shutdown }); });
  const measure = options.profile ?? measureBootstrapProfile;
  while (!signal.aborted) {
    const state = await options.client.state(signal);
    if (state.operation_id !== options.operation_id || state.runtime_key !== options.runtime_key || state.phase !== options.phase) {
      throw new Error('bootstrap state changed');
    }
    if (['failed', 'cancelled', 'cancelling'].includes(state.status)) throw new Error('bootstrap operation stopped');
    if (options.phase === 'normal' && state.normal_admitted && state.status === 'succeeded' && state.enabled && state.lifecycle_state === 'ready') {
      const final = await options.client.profile(signal);
      if (final.operation_id !== options.operation_id || final.phase !== 'normal' || final.runtime_key !== options.runtime_key
          || final.tenant_id !== options.tenant_id || final.alias !== options.alias || final.harness_id !== options.definition.id
          || final.profile_revision !== state.profile_revision || final.account_id !== state.account_id) throw new Error('bootstrap admission profile changed');
      measure(final, { apply: false, expected: final.documents });
      options.onSelection?.(selectionForProfile(options.definition.id, final.model_id, options.executionSelection ?? {}, final.reasoning_effort ?? null)); return true;
    }
    if (state.enabled || state.normal_admitted) throw new Error('bootstrap admission is unavailable');
    const probe = await options.client.claim(signal);
    if (probe === null) { await pause(signal); continue; }
    if (probe.operation_id !== options.operation_id || probe.phase !== options.phase || probe.runtime_key !== options.runtime_key
        || probe.tenant_id !== options.tenant_id || probe.alias !== options.alias || probe.harness_id !== options.definition.id
        || probe.profile_revision !== state.profile_revision || probe.account_id !== state.account_id
        || Date.parse(probe.deadline) <= Date.now()) throw new Error('bootstrap claim changed');
    const profile = await options.client.profile(signal); assertProfile(probe, profile);
    const selection = selectionForProfile(options.definition.id, profile.model_id, options.executionSelection ?? {}, profile.reasoning_effort ?? null);
    const documents = measure(profile, { apply: probe.action === 'profile', expected: probe.documents });
    let reply: string | null = null; let started = false; let verifiedModel = profile.model_id; let verifiedEffort = profile.reasoning_effort ?? null;
    if (probe.action === 'verify') {
      const definition = options.definition;
      const sessionId = definition.sessionStrategy.kind === 'generated' ? (definition.sessionStrategy.mint?.() ?? randomUUID()) : undefined;
      const override = options.commandOverride;
      const invocation = {
        command: override?.command ?? definition.command,
        args: [...(override?.prefixArgs ?? []), ...projectSelectionArguments(definition.id, override?.baseArgs ?? definition.baseArgs, selection), ...definition.sessionArgs({ resume: false,
          ...(sessionId === undefined ? {} : { sessionId }) })],
        harness: definition.id,
      };
      const result = await options.runner.run({ ...invocation, executionSelection: selection,
        ...(options.commandPins === undefined ? {} : { commandPins: options.commandPins }),
        stdin: probe.prompt, timeoutMs: Math.max(1, Math.min(45_000, Date.parse(probe.deadline) - Date.now())), signal,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(definition.startWitness === undefined ? {} : { startWitness: definition.startWitness }),
        ...(definition.stdinSource === undefined ? {} : { stdinSource: definition.stdinSource }),
      });
      if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal !== null) throw new Error('bootstrap harness failed');
      if (result.invocationWitness?.source !== 'spawn-argv' || result.invocationWitness.argvSha256 !== invocationDigest(invocation)
          || result.invocationWitness.modelId !== (selection.modelId ?? null)
          || result.invocationWitness.reasoningEffort !== (selection.reasoningEffort ?? null)
          || (options.commandPins !== undefined && result.invocationWitness.commandSha256 !== options.commandPins.sha256)) {
        throw new Error('bootstrap invocation selection is unverified');
      }
      verifiedModel = result.invocationWitness.modelId; verifiedEffort = result.invocationWitness.reasoningEffort;
      const parsed = definition.parse(result.stdout);
      if (parsed.output.reply !== `CAUCE_BOOTSTRAP_${probe.nonce}` || parsed.output.messages.length !== 0 || parsed.output.notify.length !== 0
          || parsed.output.status === 'failed' || (result.harnessStarted !== true && !parsed.nativeSessionId)) throw new Error('bootstrap provider proof is unavailable');
      reply = parsed.output.reply; started = true;
      measure(profile, { apply: false, expected: documents });
    }
    const current = await options.client.profile(signal); assertProfile(probe, current);
    const proof: BootstrapProof = { operation_id: probe.operation_id, phase: probe.phase, runtime_key: probe.runtime_key, nonce: probe.nonce,
      claim_token: probe.claim_token, account_id: probe.account_id, profile_revision: probe.profile_revision,
      harness_id: probe.harness_id, model_id: verifiedModel, reasoning_effort: verifiedEffort, documents, reply, harness_started: started };
    await options.client.ack(probe, proof, signal);
  }
  return false;
}

export async function bootstrapOnStartup(options: Omit<BootstrapRunnerOptions, 'operation_id' | 'phase' | 'runtime_key' | 'client'> & {
  tls?: { certFile: string; keyFile: string; caFile: string }; environment?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const operationId = environment.CAUCE_FLEET_OPERATION_ID;
  if (operationId === undefined) {
    if (environment.CAUCE_BOOTSTRAP === '1') throw new Error('bootstrap operation is required');
    return true;
  }
  if (environment.CAUCE_BOOTSTRAP !== '1' && environment.CAUCE_BOOTSTRAP !== '0') throw new Error('bootstrap phase is required');
  const phase = environment.CAUCE_BOOTSTRAP === '1' ? 'bootstrap' : 'normal';
  const origin = phase === 'bootstrap' ? environment.CAUCE_BOOTSTRAP_URL : environment.CAUCE_GATEWAY_URL;
  const runtimeKey = environment.CAUCE_RUNTIME_KEY;
  if (origin === undefined || runtimeKey === undefined || options.tls === undefined) throw new Error('bootstrap transport is unavailable');
  const { BootstrapClient } = await import('./bootstrap-client.js');
  const client = new BootstrapClient({ origin, operation_id: operationId, phase, runtime_key: runtimeKey, tls: options.tls });
  const shutdown = new AbortController(); const stop = () => { shutdown.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await runBootstrap({ ...options, client, phase, operation_id: operationId, runtime_key: runtimeKey }, shutdown.signal); }
  catch (error) { if (shutdown.signal.aborted) return false; throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); client.close(); }
}
