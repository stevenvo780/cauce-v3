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
