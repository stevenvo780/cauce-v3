import { describe, expect, it } from 'vitest';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { preparedProfileReceipt } from './profile-save-receipt';

const before: AgentPerfil = { publicado: true, tenant_id: 'Steven', alias: 'kant', agent_enabled: false,
  can_prepare_draft: true, exists: true, revision: 4, applied_revision: 3, runtime_state: 'disabled',
  perfil: { purpose: null, role_summary: null, human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [] } };
const fields: AgentPerfilCampos = { purpose: ' Nuevo ', role_summary: '', human_brief: '', responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
const receipt = { ok: true, state: 'prepared_disabled', tenant_id: 'Steven', alias: 'kant', agent_enabled: false,
  revision: 5, desired_revision: 5, applied_revision: 3, perfil: { ...before.perfil, tenant_id: 'Steven', alias: 'kant', purpose: 'Nuevo' } };
describe('desired-only preparation receipts', () => {
  it('matches all normalized profile fields, exact scope and unchanged applied revision', () => {
    expect(preparedProfileReceipt(receipt, before, fields, 'Steven', 'kant')).toEqual({ revision: 5, appliedRevision: 3 });
    for (const perfil of [{ ...receipt.perfil, purpose: 'Other' }, { ...receipt.perfil, tools: ['other'] },
      { ...receipt.perfil, human_brief: undefined }, { ...receipt.perfil, alias: 'other' }]) {
      expect(preparedProfileReceipt({ ...receipt, perfil }, before, fields, 'Steven', 'kant')).toBeUndefined();
    }
  });
  it('accepts first profile creation at desired 1 with no previous applied revision', () => {
    const empty = { ...before, exists: false, revision: null, applied_revision: null };
    expect(preparedProfileReceipt({ ...receipt, revision: 1, desired_revision: 1, applied_revision: null }, empty, fields, 'Steven', 'kant'))
      .toEqual({ revision: 1, appliedRevision: null });
    expect(preparedProfileReceipt({ ...receipt, revision: 2, desired_revision: 2, applied_revision: null }, empty, fields, 'Steven', 'kant')).toBeUndefined();
  });
  it('accepts idempotent normalization without advancing desired and refuses manufactured runtime evidence', () => {
    const current = { ...before, perfil: { ...before.perfil, purpose: 'Nuevo' } };
    const repeated = { ...receipt, revision: 4, desired_revision: 4 };
    expect(preparedProfileReceipt(repeated, current, fields, 'Steven', 'kant')).toEqual({ revision: 4, appliedRevision: 3 });
    expect(preparedProfileReceipt(receipt, current, fields, 'Steven', 'kant')).toBeUndefined();
    expect(preparedProfileReceipt({ ...repeated, acknowledgements: [] }, current, fields, 'Steven', 'kant')).toBeUndefined();
    expect(preparedProfileReceipt(repeated, { ...current, can_prepare_draft: undefined }, fields, 'Steven', 'kant')).toBeUndefined();
  });
});
