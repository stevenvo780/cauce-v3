import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationMutationHashInput, publicConfigurationMutation, sha256Hex, type ConfigMutation } from '@cauce/protocol';
import { validatedConfigurationReceipt } from './helpers.js';
import { DevOnlyAuthProvider } from '../../auth.js';
import { fakePool } from '../../test-support/gateway-doubles.js';
import type { ConsoleRouteRepository } from './contracts.js';
import { registerConsoleOperationsRoutes } from './operations.js';

const mutation: ConfigMutation = { resource: 'provider_account', action: 'create', id: 'one', value: {
  provider: 'codex', external_account_id: 'acct', payer_tenant_id: 'A', credential_ref_kind: 'env_path', credential_ref: 'PRIVATE_LOCATOR', enabled: false } };
const inverse: ConfigMutation = { resource: 'provider_account', action: 'delete', id: 'one' };
const hash = sha256Hex(configurationMutationHashInput(mutation));
const receipt = { applied: true, dry_run: false, revision: 7, summary: 'create account', rolled_back_revision_id: null,
  mutation: publicConfigurationMutation(mutation), inverse_mutation: inverse, mutation_sha256: hash };
const apps: FastifyInstance[] = [];
const headers = { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' };
function route(value: unknown) {
  const repository = { applyConfigurationChange: vi.fn(async () => value) };
  const app = Fastify({ logger: false });
  registerConsoleOperationsRoutes(app, {
    options: { pool: fakePool(), authProvider: DevOnlyAuthProvider.forTests() },
    repository: repository as unknown as ConsoleRouteRepository, allowedJobKinds: new Set(),
  });
  apps.push(app);
  return { app, repository };
}
afterEach(async () => { while (apps.length > 0) await apps.pop()?.close(); });
describe('public configuration receipt validation', () => {
  it('credits an exact full intent hash without publishing its credential locator', () => {
    const validated = validatedConfigurationReceipt(receipt, false, null, mutation);
    expect(validated.mutation_sha256).toBe(hash);
    expect(JSON.stringify(validated)).not.toContain('PRIVATE_LOCATOR');
  });
  it('rejects missing, malformed or another locator hash even with an identical visible projection', () => {
    for (const mutation_sha256 of [undefined, 'bad', 'a'.repeat(64)]) {
      expect(() => validatedConfigurationReceipt({ ...receipt, mutation_sha256 }, false, null, mutation)).toThrow(/exact durable receipt/);
    }
    expect(() => validatedConfigurationReceipt(receipt, false, null, { ...mutation, value: { ...mutation.value, credential_ref: 'OTHER_LOCATOR' } })).toThrow();
  });
  it('rejects unredacted mutation and inverse payloads before returning a response', () => {
    expect(() => validatedConfigurationReceipt({ ...receipt, mutation }, false, null, mutation)).toThrow();
    expect(() => validatedConfigurationReceipt({ ...receipt, inverse_mutation: mutation }, false, null, mutation)).toThrow();
  });
  it('credits exact public legacy mock receipts but never a different public mutation', () => {
    const publicMutation: ConfigMutation = { resource: 'room', action: 'update', tenant_id: 'A', id: 'room', value: { enabled: false } };
    const legacy = { ...receipt, mutation: publicMutation, inverse_mutation: publicMutation, mutation_sha256: undefined };
    expect(validatedConfigurationReceipt(legacy, false, null, publicMutation).mutation).toEqual(publicMutation);
    expect(() => validatedConfigurationReceipt(legacy, false, null, { ...publicMutation, id: 'other' })).toThrow();
  });
  it('binds a redacted batch to its full ordered intent', () => {
    const batch: ConfigMutation = { resource: 'batch', action: 'apply', mutations: [mutation, inverse] };
    const batchReceipt = { ...receipt, mutation: publicConfigurationMutation(batch), mutation_sha256: sha256Hex(configurationMutationHashInput(batch)) };
    expect(validatedConfigurationReceipt(batchReceipt, false, null, batch).mutation).toEqual(publicConfigurationMutation(batch));
    expect(() => validatedConfigurationReceipt(batchReceipt, false, null, { ...batch, mutations: [inverse, mutation] })).toThrow();
  });
});

describe('public configuration receipt transport', () => {
  it.each([true, false])('returns a redacted exact account receipt over HTTP with dry_run=%s', async (dry_run) => {
    const { app, repository } = route({ ...receipt, applied: !dry_run, dry_run });
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run, expected_revision: 6, mutation } });
    expect(response.statusCode).toBe(dry_run ? 200 : 201);
    expect(response.json()).toEqual({ ...receipt, applied: !dry_run, dry_run });
    expect(response.body).not.toContain('PRIVATE_LOCATOR');
    expect(repository.applyConfigurationChange).toHaveBeenCalledWith('Steven', 'kant', mutation, dry_run, 6);
  });
  it.each([undefined, 'a'.repeat(64)])('returns conflict for an unverifiable full intent hash %s', async (mutation_sha256) => {
    const { app } = route({ ...receipt, mutation_sha256 });
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run: false, expected_revision: 6, mutation } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
    expect(response.body).not.toContain('PRIVATE_LOCATOR');
  });
});
