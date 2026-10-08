import { createHash } from 'node:crypto';
import type { CommandRunRequest, HarnessId } from './types.js';

export interface ExecutionSelection { readonly modelId?: string; readonly reasoningEffort?: string }
export interface InvocationWitness {
  readonly source: 'spawn-argv'; readonly argvSha256: string; readonly modelId: string | null;
  readonly reasoningEffort: string | null; readonly commandSha256?: string;
}
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/u;
const CODEX_EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CLAUDE_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const OPENCLAW_EFFORT = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max']);

export function executionSelection(harness: HarnessId, value: ExecutionSelection): ExecutionSelection {
  if (value.modelId !== undefined && !MODEL.test(value.modelId)) throw new Error('invalid selected model');
  if (value.modelId === undefined && value.reasoningEffort === undefined) return {};
  if (harness !== 'codex' && harness !== 'claude' && harness !== 'openclaw') throw new Error('harness has no verified model selection projection');
  const efforts = harness === 'codex' ? CODEX_EFFORT : harness === 'openclaw' ? OPENCLAW_EFFORT : CLAUDE_EFFORT;
  if (value.reasoningEffort !== undefined && !efforts.has(value.reasoningEffort)) {
    throw new Error('unsupported selected reasoning effort');
  }
  return { ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}
export function selectionFromEnvironment(harness: HarnessId, environment: NodeJS.ProcessEnv = process.env): ExecutionSelection {
  return executionSelection(harness, { ...(environment.CAUCE_MODEL_ID === undefined ? {} : { modelId: environment.CAUCE_MODEL_ID }),
    ...(environment.CAUCE_REASONING_EFFORT === undefined ? {} : { reasoningEffort: environment.CAUCE_REASONING_EFFORT }) });
}
export function selectionArguments(harness: HarnessId, value: ExecutionSelection): string[] {
  const selected = executionSelection(harness, value);
  return [...(selected.modelId === undefined ? [] : ['--model', selected.modelId]),
    ...(selected.reasoningEffort === undefined ? [] : harness === 'codex'
      ? ['-c', `model_reasoning_effort=${selected.reasoningEffort}`]
      : [harness === 'openclaw' ? '--thinking' : '--effort', selected.reasoningEffort])];
}
export function projectSelectionArguments(harness: HarnessId, args: readonly string[], selected: ExecutionSelection): string[] {
  const flags = selectionArguments(harness, selected);
  if (selected.modelId !== undefined && args.some(arg => /^(?:--model(?:=|$)|-m$|model=)/u.test(arg))) {
    throw new Error('selected model conflicts with existing command arguments');
  }
  if (selected.reasoningEffort !== undefined && args.some(arg => /^(?:--effort(?:=|$)|--thinking(?:=|$)|model_reasoning_effort=)/u.test(arg))) {
    throw new Error('selected reasoning effort conflicts with existing command arguments');
  }
  return [...args, ...flags];
}
export function selectionForProfile(harness: HarnessId, modelId: string | null, configured: ExecutionSelection, reasoningEffort: string | null = null): ExecutionSelection {
  if (configured.modelId !== undefined && configured.modelId !== modelId) throw new Error('selected model differs from durable profile');
  if (configured.reasoningEffort !== undefined && configured.reasoningEffort !== reasoningEffort) throw new Error('selected reasoning effort differs from durable profile');
  return executionSelection(harness, { ...(modelId === null ? {} : { modelId }), ...(reasoningEffort === null ? {} : { reasoningEffort }) });
}
export function invocationDigest(request: Pick<CommandRunRequest, 'command' | 'args' | 'harness'>): string {
  return createHash('sha256').update(JSON.stringify({ command: request.command, args: request.args, harness: request.harness })).digest('hex');
}
export function witnessForInvocation(request: CommandRunRequest, commandSha256?: string): InvocationWitness | undefined {
  const selected = request.executionSelection;
  if (selected === undefined) return undefined;
  const flags = selectionArguments(request.harness, selected);
  if (selected.modelId !== undefined && request.args.filter(arg => /^(?:--model(?:=|$)|-m$|model=)/u.test(arg)).length !== 1) {
    throw new Error('spawned command has an ambiguous model selection');
  }
  if (selected.reasoningEffort !== undefined && request.args.filter(arg => /^(?:--effort(?:=|$)|--thinking(?:=|$)|model_reasoning_effort=)/u.test(arg)).length !== 1) {
    throw new Error('spawned command has an ambiguous reasoning effort');
  }
  if (flags.length !== 0 && !request.args.some((_arg, index) => flags.every((flag, offset) => request.args[index + offset] === flag))) {
    throw new Error('execution selection did not reach the spawned command');
  }
  return { source: 'spawn-argv', argvSha256: invocationDigest(request), modelId: selected.modelId ?? null,
    reasoningEffort: selected.reasoningEffort ?? null, ...(commandSha256 === undefined ? {} : { commandSha256 }) };
}
