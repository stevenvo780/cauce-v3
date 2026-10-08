import { describe, expect, it } from 'vitest';
import type { ConfigMutation } from '../../api/types';
import { exactConfigurationReceipt } from './config-receipt';

const requested: ConfigMutation = {
  resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true },
};
const inverse: ConfigMutation = {
  resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: false },
};

describe('exact configuration receipt', () => {
  it('credits logical retirement receipts and rejects nested batch inverses', () => {
    const retired: ConfigMutation = { resource: 'room', action: 'retire', tenant_id: 'Miguel', id: 'grp.miguel' };
    const restored: ConfigMutation = { ...retired, action: 'restore' };
    const receipt = { applied: false, dry_run: true, revision: 1, summary: 'retire room', rolled_back_revision_id: null, mutation: retired, inverse_mutation: restored };
    expect(exactConfigurationReceipt(receipt, true, retired)).toBe(true);
    const batch: ConfigMutation = { resource: 'batch', action: 'apply', mutations: [retired, restored] };
    expect(exactConfigurationReceipt({ ...receipt, mutation: batch, inverse_mutation: batch }, true, batch)).toBe(true);
    expect(exactConfigurationReceipt({ ...receipt, mutation: batch, inverse_mutation: { ...batch, mutations: [batch] } } as unknown as Parameters<typeof exactConfigurationReceipt>[0], true, batch)).toBe(false);
  });
  it('requires exact apply/dry-run semantics, revision, mutation and inverse', () => {
    const receipt = {
      applied: true, dry_run: false, revision: 2, summary: 'update tenant Steven',
      rolled_back_revision_id: null, mutation: requested, inverse_mutation: inverse,
    };
    expect(exactConfigurationReceipt(receipt, false, requested)).toBe(true);
    expect(exactConfigurationReceipt({ ...receipt, applied: false }, false, requested)).toBe(false);
    expect(exactConfigurationReceipt({ ...receipt, dry_run: true }, false, requested)).toBe(false);
    expect(exactConfigurationReceipt({ ...receipt, inverse_mutation: null }, false, requested)).toBe(false);
  });

  it('rejects a 2xx for a different mutation and accepts property-order differences', () => {
    const reordered: ConfigMutation = {
      action: 'update', value: { enabled: true }, id: 'Steven', resource: 'tenant',
    };
    const receipt = {
      applied: false, dry_run: true, revision: 1, summary: 'preview tenant Steven',
      rolled_back_revision_id: null, mutation: reordered, inverse_mutation: inverse,
    };
    expect(exactConfigurationReceipt(receipt, true, requested)).toBe(true);
    expect(exactConfigurationReceipt({
      ...receipt, mutation: { ...requested, id: 'Miguel' },
    }, true, requested)).toBe(false);
  });

  it('binds an otherwise valid rollback receipt to the exact requested revision', () => {
    const receipt = {
      applied: true, dry_run: false, revision: 9, summary: 'rollback 7: update tenant Steven',
      rolled_back_revision_id: 7, mutation: requested, inverse_mutation: inverse,
    };

    expect(exactConfigurationReceipt(receipt, false, undefined, 7)).toBe(true);
    expect(exactConfigurationReceipt({
      ...receipt, rolled_back_revision_id: 8,
    }, false, undefined, 7)).toBe(false);
    expect(exactConfigurationReceipt({
      ...receipt, rolled_back_revision_id: undefined,
    }, false, undefined, 7)).toBe(false);
    expect(exactConfigurationReceipt({
      ...receipt, rolled_back_revision_id: null,
    }, false, undefined, 7)).toBe(false);
  });
});

it('credits a redacted locator only with the full pre-request intent hash and rejects a different locator', async () => {
  const { configurationMutationSha256, publicConfigurationMutation } = await import('@cauce/protocol/configuration');
  const account = { resource: 'provider_account', action: 'create', id: 'private-account', value: {
    provider: 'codex', payer_tenant_id: 'Steven', external_account_id: 'one', credential_ref_kind: 'env_path', credential_ref: 'PRIVATE_LOCATOR' } } satisfies ConfigMutation;
  const hash = await configurationMutationSha256(account);
  const receipt = { applied: false, dry_run: true, revision: 1, summary: 'create account', rolled_back_revision_id: null,
    mutation: publicConfigurationMutation(account), inverse_mutation: { resource: 'provider_account' as const, action: 'delete' as const, id: account.id }, mutation_sha256: hash };
  expect(exactConfigurationReceipt(receipt, true, account, null, hash)).toBe(true);
  expect(exactConfigurationReceipt({ ...receipt, mutation_sha256: undefined }, true, account, null, hash)).toBe(false);
  expect(exactConfigurationReceipt({ ...receipt, mutation_sha256: 'a'.repeat(64) }, true, account, null, hash)).toBe(false);
  const changed = { ...account, value: { ...account.value, credential_ref: 'OTHER_LOCATOR' } };
  expect(exactConfigurationReceipt(receipt, true, changed, null, await configurationMutationSha256(changed))).toBe(false);
  expect(exactConfigurationReceipt({ ...receipt, mutation: account }, true, account, null, hash)).toBe(false);
});
