import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentQuotaReceiptSchema, DOCUMENTOS_DE_GOBIERNO, PRESUPUESTOS_DE_CONTEXTO,
  QuotaEnvironmentProviderSchema } from '@cauce/protocol';
import { publishedHarnessDescriptor, type HarnessDescriptor } from '../../adapter-sdk/src/context/harness-descriptor.js';
import { harnessContextLimits, harnessContextMaxBytes } from './context-version-model.js';
import { harnessFromCapabilities, harnessFromCommand, isDocumentHarness,
  resolveAgentDocuments } from '../../../services/gateway/src/console/agent-documents/catalog.js';
import { HostCapabilitiesSchema } from '../../../services/gateway/src/fleet/host-channel.capabilities.js';
import { QuotaExecutionSchema } from '../../../services/gateway/src/fleet/quota-host-command.js';
import { ARNESES_REALES } from '../../../console/src/features/config/arneses.js';

// Console modules use bundler resolution rather than the core's NodeNext source graph.
const { EXECUTABLE_QUOTA_PROVIDERS } = await import(new URL('../../../console/src/features/accounts/quota-environment-capabilities.ts', import.meta.url).href) as {
  readonly EXECUTABLE_QUOTA_PROVIDERS: ReadonlySet<string> };
const { quotaEnvironments } = await import(new URL('../../../console/src/api/client/quota-responses.ts', import.meta.url).href) as {
  quotaEnvironments: (value: unknown) => unknown };

// These descriptors have no measured document inventory implementation.
const WITHOUT_DOCUMENT_INVENTORY = ['fake', 'fake2', 'opencode'];
// Retained in the applied SQL contract; no harness descriptor publishes them.
// agy is quota-only (fixed argv in ops/cli/quota_runtime.py), gemini is retired.
const NON_HARNESS_QUOTA_PROVIDERS = ['agy', 'gemini'];
const sorted = (values: Iterable<string>): string[] => [...values].sort();

async function descriptors(): Promise<readonly HarnessDescriptor[]> {
  const configured = process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
  const directory = configured === undefined ? new URL('../../adapter-sdk/descriptors/', import.meta.url)
    : pathToFileURL(`${configured}/`);
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  expect(names.length).toBeGreaterThan(0);
  return Promise.all(names.map(name => publishedHarnessDescriptor(directory, name.slice(0, -5))));
}

function quotaReaders(published: readonly HarnessDescriptor[]): string[] {
  return published.filter(descriptor => descriptor.operations.quota === 'quota-collector'
    && descriptor.provider?.quota_argv !== undefined).map(descriptor => descriptor.harness).sort();
}

function quotaLoginProviders(published: readonly HarnessDescriptor[]): string[] {
  return published.filter(descriptor => descriptor.operations.authenticate === 'provider-login'
    && descriptor.provider?.authenticate_argv !== undefined).map(descriptor => descriptor.harness).sort();
}

describe('runtime catalogs match published descriptors', () => {
  it('covers every context limit exactly, including ids with the default limit', async () => {
    const published = await descriptors();
    const limits = harnessContextLimits();
    expect(sorted(limits.keys())).toEqual(sorted(published.map(descriptor => descriptor.harness)));
    for (const descriptor of published) {
      expect(limits.get(descriptor.harness), descriptor.harness).toBe(descriptor.context.max_bytes);
    }
  });

  it('does not expose mutable context limits', () => {
    (harnessContextLimits() as Map<string, number>).set('codex', 1);
    expect(harnessContextMaxBytes('codex')).toBe(harnessContextLimits().get('codex'));
    expect(harnessContextMaxBytes('codex')).toBeGreaterThan(1);
  });

  it('keeps persisted quota enums and the console response validator in parity', async () => {
    const published = await descriptors();
    const providers = sorted(new Set([...quotaReaders(published), ...quotaLoginProviders(published),
      ...NON_HARNESS_QUOTA_PROVIDERS]));
    expect(sorted(QuotaEnvironmentProviderSchema.options)).toEqual(providers);
    expect(sorted(HostCapabilitiesSchema.shape.quota_providers.unwrap().element.options)).toEqual(providers);
    for (const provider of [...providers, 'unpublished']) {
      const snapshot = { company_id: 'example', capabilities: { available: true, providers: [provider], actions: [], hosts: [] },
        environments: [], operations: [] };
      if (providers.includes(provider)) expect(quotaEnvironments(snapshot)).toEqual(snapshot);
      else expect(() => quotaEnvironments(snapshot)).toThrow();
    }
  });

  it('keeps executable quota contracts and console choices equal to descriptor readers', async () => {
    const published = await descriptors();
    const readers = quotaReaders(published);
    const executable = sorted(new Set([...readers, ...quotaLoginProviders(published), 'agy']));
    expect(sorted(AgentQuotaReceiptSchema.options[0].shape.provider.options)).toEqual(readers);
    expect(sorted(QuotaExecutionSchema.shape.environment.shape.provider.options)).toEqual(executable);
    expect(sorted(EXECUTABLE_QUOTA_PROVIDERS)).toEqual(executable);
  });

  it('keeps protocol governance, measured gateway inventory and console aligned', async () => {
    const published = await descriptors();
    const names = published.map(descriptor => descriptor.harness);
    for (const omitted of WITHOUT_DOCUMENT_INVENTORY) expect(names).toContain(omitted);
    const inventory = published.filter(descriptor => !WITHOUT_DOCUMENT_INVENTORY.includes(descriptor.harness));
    const expected = sorted(inventory.map(descriptor => descriptor.harness));
    expect(sorted(Object.keys(DOCUMENTOS_DE_GOBIERNO))).toEqual(expected);
    expect(sorted(Object.keys(PRESUPUESTOS_DE_CONTEXTO))).toEqual(expected);
    expect(sorted(ARNESES_REALES.map(harness => harness.id))).toEqual(expected);
    for (const descriptor of inventory) {
      const harness = descriptor.harness;
      expect(harnessFromCommand(`/app/bin/${harness}.js`)).toBe(harness);
      expect(harnessFromCommand(`/app/bin/wrapper.js /app/bin/${harness}.js`)).toBe(harness);
      expect(harnessFromCapabilities([`harness.${harness}`])).toBe(harness);
      expect(isDocumentHarness(harness)).toBe(true);
      if (!isDocumentHarness(harness)) throw new Error(`missing document inventory: ${harness}`);
      expect(DOCUMENTOS_DE_GOBIERNO[harness].documentos).toContain(descriptor.context.native_document);
      const documents = resolveAgentDocuments({ harness, home: '/home/agent', claudeConfigDir: '/home/agent/.claude',
        codexHome: '/home/agent/.codex', openclawWorkspace: '/workspace', museWorkspace: '/workspace', grokWorkspace: '/workspace' });
      expect(documents.some(document => document.path.endsWith(`/${descriptor.context.native_document}`)), harness).toBe(true);
    }
    for (const unknown of [...WITHOUT_DOCUMENT_INVENTORY, 'unknown', 'constructor', 'toString', '__proto__', 'new-harness']) {
      expect(isDocumentHarness(unknown)).toBe(false);
      expect(harnessFromCommand(`/app/bin/${unknown}.js`)).toBe('unknown');
      expect(harnessFromCapabilities([`harness.${unknown}`])).toBe('unknown');
    }
  });
});
