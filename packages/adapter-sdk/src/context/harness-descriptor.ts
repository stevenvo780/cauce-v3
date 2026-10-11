import { readFile } from 'node:fs/promises';
import { harnessDefinition } from '../harnesses/index.js';
import type { HarnessDefinition, HarnessId } from '../sdk/types.js';

export type HarnessLifecycleOperation = 'install' | 'authenticate' | 'execute' | 'update' | 'quota';
export type HarnessLifecycleRecipe = 'runtime-package' | 'provider-login' | 'native-execution' | 'provider-update' | 'quota-collector';
export interface HarnessDescriptor {
  readonly schema_version: 1;
  readonly harness: HarnessId;
  readonly operations: Readonly<Partial<Record<HarnessLifecycleOperation, HarnessLifecycleRecipe>>>;
  readonly context: { readonly native_document: 'AGENTS.md' | 'CLAUDE.md' | 'SOUL.md' | 'none'; readonly max_bytes: number };
}
const RECIPES: Readonly<Record<HarnessLifecycleOperation, HarnessLifecycleRecipe>> = {
  install: 'runtime-package', authenticate: 'provider-login', execute: 'native-execution', update: 'provider-update', quota: 'quota-collector',
};
const HARNESSES = new Set<HarnessId>(['claude', 'codex', 'hermes', 'opencode', 'openclaw', 'grok', 'muse', 'fake']);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid harness descriptor object');
  return value as Record<string, unknown>;
}
export function parseHarnessDescriptor(value: unknown): HarnessDescriptor {
  const raw = object(value);
  if (raw.schema_version !== 1 || typeof raw.harness !== 'string' || !HARNESSES.has(raw.harness as HarnessId)
    || Object.keys(raw).some(key => !['schema_version', 'harness', 'operations', 'context'].includes(key))) throw new Error('invalid harness descriptor');
  const operations = object(raw.operations);
  for (const [name, recipe] of Object.entries(operations)) {
    if (!Object.hasOwn(RECIPES, name) || recipe !== RECIPES[name as HarnessLifecycleOperation]) throw new Error('unsupported harness operation recipe');
  }
  if (operations.execute !== 'native-execution') throw new Error('harness descriptor must support execution');
  const context = object(raw.context);
  if (Object.keys(context).length !== 2 || typeof context.native_document !== 'string'
    || !['AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'none'].includes(context.native_document)
    || typeof context.max_bytes !== 'number' || !Number.isSafeInteger(context.max_bytes)
    || context.max_bytes < 1024 || context.max_bytes > 262_144) throw new Error('invalid harness context descriptor');
  return Object.freeze({ schema_version: 1, harness: raw.harness as HarnessId,
    operations: Object.freeze({ ...operations }),
    context: Object.freeze({ native_document: context.native_document, max_bytes: context.max_bytes }) as HarnessDescriptor['context'] });
}
export async function packagedHarnessDescriptor(harness: HarnessId): Promise<HarnessDescriptor> {
  const value: unknown = JSON.parse(await readFile(new URL(`../../descriptors/${harness}.json`, import.meta.url), 'utf8'));
  const descriptor = parseHarnessDescriptor(value);
  if (descriptor.harness !== harness) throw new Error('harness descriptor identity differs');
  return descriptor;
}
export interface HarnessLifecycleExecutor {
  run(input: { readonly harness: HarnessId; readonly operation: HarnessLifecycleOperation; readonly recipe: HarnessLifecycleRecipe }): Promise<unknown>;
}
export async function executeHarnessOperation(descriptor: HarnessDescriptor, operation: HarnessLifecycleOperation,
  executor: HarnessLifecycleExecutor): Promise<unknown> {
  const valid = parseHarnessDescriptor(descriptor);
  const recipe = valid.operations[operation];
  if (recipe === undefined) throw new Error(`harness operation ${operation} is unsupported`);
  return executor.run({ harness: valid.harness, operation, recipe });
}
export function definitionFromDescriptor(descriptor: HarnessDescriptor): HarnessDefinition {
  const valid = parseHarnessDescriptor(descriptor);
  if (valid.operations.execute !== 'native-execution') throw new Error('native execution recipe is required');
  return harnessDefinition(valid.harness);
}
