import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConfigMutation } from '../src/schemas/types.js';
import { configurationMutationHashInput, configurationMutationSha256, configurationReceiptMatches, publicConfigurationMutation } from '../src/configuration-receipt.js';

const account: ConfigMutation = { resource: 'provider_account', action: 'create', id: 'one', value: {
  provider: 'codex', external_account_id: 'acct', payer_tenant_id: 'A', credential_ref_kind: 'env_path', credential_ref: 'PRIVATE_LOCATOR', enabled: false } };
describe('configuration public receipts', () => {
  it('hashes full schema-normalized intent with identical browser and server bytes', async () => {
    const expected = createHash('sha256').update(configurationMutationHashInput(account)).digest('hex');
    expect(await configurationMutationSha256(account)).toBe(expected);
    const reordered = { id: account.id, action: account.action, value: account.value, resource: account.resource };
    expect(await configurationMutationSha256(reordered)).toBe(expected);
    expect(await configurationMutationSha256({ ...account, value: { ...account.value, credential_ref: 'OTHER_LOCATOR' } })).not.toBe(expected);
  });
  it('projects nested account leaves without mutating original durable inputs', () => {
    const input: ConfigMutation = { resource: 'batch', action: 'apply', mutations: [account] };
    const original = structuredClone(input);
    expect(JSON.stringify(publicConfigurationMutation(input))).not.toContain('PRIVATE_LOCATOR');
    expect(input).toEqual(original);
  });
  it('requires the full intent hash when projection differs and rejects unredacted or mismatched receipts', async () => {
    const projected = publicConfigurationMutation(account);
    const hash = await configurationMutationSha256(account);
    expect(configurationReceiptMatches(projected, account, hash, hash)).toBe(true);
    expect(configurationReceiptMatches(projected, account, undefined, hash)).toBe(false);
    expect(configurationReceiptMatches(projected, account, 'a'.repeat(64), hash)).toBe(false);
    expect(configurationReceiptMatches(projected, { ...account, value: { ...account.value, credential_ref: 'OTHER_LOCATOR' } }, hash,
      await configurationMutationSha256({ ...account, value: { ...account.value, credential_ref: 'OTHER_LOCATOR' } }))).toBe(false);
    expect(configurationReceiptMatches(account, account, hash, hash)).toBe(false);
  });
  it('preserves exact legacy equality for public requests and rejects other visible values', () => {
    const room: ConfigMutation = { resource: 'room', action: 'update', tenant_id: 'A', id: ' Sala ', value: { enabled: false } };
    expect(configurationReceiptMatches(room, room, undefined)).toBe(true);
    expect(configurationReceiptMatches({ ...room, id: 'Sala' }, room, undefined)).toBe(false);
    expect(configurationReceiptMatches(room, room, 'invalid')).toBe(false);
  });
});
