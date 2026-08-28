import { ApiError } from '../../api/client';
import type { ConfigurationSnapshot } from '../../api/types';
import {
  accountDraftError, bindingMutation, buildAssignmentMatrix, ceilingMutation, credentialRefError,
  createAccountMutation, describeRegistryError, readAgents, readBindings, readCeiling,
  readProviderAccounts, redactPreview, updateAccountMutation, viewerTenant,
  type AccountDraft, type RegistryContext,
} from './registry';

const snapshot: ConfigurationSnapshot = {
  revision: 7,
  tenants: [{ id: 'Steven' }, { id: 'Pablo' }],
  agents: [
    { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', display_name: 'Kant', enabled: true, container_name: 'ws-kant', runtime_user: 'dev' },
    { tenant_id: 'Steven', alias: 'argos', harness_id: null, display_name: null, enabled: false, container_name: null, runtime_user: null },
  ],
  provider_accounts: [
    { id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex', shared_with_pool: true, enabled: true, external_account_id: 'org-9f21', credential_ref_kind: 'env_path' },
    { id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax', shared_with_pool: true, enabled: true, external_account_id: null, credential_ref_kind: null },
  ],
  alias_routing_ceiling: [
    { tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' },
    { tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo', account_payer_tenant: 'Pablo', created_by_tenant: 'Steven' },
  ],
  agent_account_bindings: [
    { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'minimax-pablo', priority: 50, enabled: true },
    { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven', priority: 10, enabled: true },
  ],
};

function contextFrom(source: ConfigurationSnapshot = snapshot): RegistryContext {
  return {
    accounts: readProviderAccounts(source).items,
    agents: readAgents(source).items,
    ceiling: readCeiling(source).items,
    bindings: readBindings(source).items,
    tenantIds: (source.tenants ?? []).map((row) => String(row.id)),
  };
}

it('distingue una clave ausente del snapshot de una lista vacía', () => {
  expect(readProviderAccounts({ revision: 1 })).toEqual({ available: false, items: [] });
  expect(readProviderAccounts({ revision: 1, provider_accounts: [] })).toEqual({ available: true, items: [] });
});

it('marca como redactado —y no como vacío— el campo que el servidor anula por ser de otro pagador', () => {
  const accounts = readProviderAccounts(snapshot).items;
  expect(accounts[0]).toMatchObject({ id: 'codex-steven', payerFields: 'visible', externalAccountId: 'org-9f21', credentialRefKind: 'env_path' });
  expect(accounts[1]).toMatchObject({ id: 'minimax-pablo', payerFields: 'redacted', externalAccountId: null, credentialRefKind: null });
});

it('trata la ausencia total de la clave del pagador como no publicada por el gateway', () => {
  const accounts = readProviderAccounts({
    provider_accounts: [{ id: 'x', provider: 'codex', payer_tenant_id: 'Steven', shared_with_pool: false, enabled: false }],
  }).items;
  expect(accounts[0]?.payerFields).toBe('absent');
});

it('deriva "prestada" del pagador que informa el servidor, no del cliente', () => {
  const ceiling = readCeiling(snapshot).items;
  expect(ceiling.find((entry) => entry.accountId === 'codex-steven')?.borrowed).toBe(false);
  expect(ceiling.find((entry) => entry.accountId === 'minimax-pablo')?.borrowed).toBe(true);
});

it('ordena el fallback por priority y deja fuera del orden lo que no tiene binding habilitado', () => {
  const context = contextFrom();
  const matrix = buildAssignmentMatrix(context.agents, context.accounts, context.ceiling, context.bindings);
  const kant = matrix.find((row) => row.agent.alias === 'kant');

  expect(kant?.fallback.map((step) => [step.rank, step.accountId, step.priority])).toEqual([
    [1, 'codex-steven', 10],
    [2, 'minimax-pablo', 50],
  ]);
  expect(kant?.fallback[1]?.borrowed).toBe(true);
  expect(kant?.cells.map((cell) => cell.state)).toEqual(['bound-enabled', 'bound-enabled']);

  const argos = matrix.find((row) => row.agent.alias === 'argos');
  expect(argos?.fallback).toEqual([]);
  expect(argos?.cells.every((cell) => cell.state === 'none')).toBe(true);
});

it('marca el techo sin binding habilitado como alcanzable pero nunca elegido', () => {
  const context = contextFrom({
    ...snapshot,
    agent_account_bindings: [{ tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven', priority: 10, enabled: false }],
  });
  const kant = buildAssignmentMatrix(context.agents, context.accounts, context.ceiling, context.bindings)[0];
  expect(kant).toBeDefined();
  expect(kant.cells.map((cell) => cell.state)).toEqual(['bound-disabled', 'ceiling-only']);
  expect(kant.fallback).toEqual([]);
  expect(kant.idleCeiling).toEqual(['codex-steven', 'minimax-pablo']);
});

it('valida el locator con las mismas formas que el CHECK de la migración', () => {
  expect(credentialRefError('env_path', 'CAUCE_CODEX_STEVEN_PATH')).toBeUndefined();
  expect(credentialRefError('env_path', 'OPENAI_API_KEY')).toMatch(/CAUCE_/);
  expect(credentialRefError('file', '/etc/cauce-v3/codex.json')).toBeUndefined();
  expect(credentialRefError('file', '/etc//codex.json')).toMatch(/\/\//);
  expect(credentialRefError('file', '/etc/../codex.json')).toMatch(/segmentos/);
  expect(credentialRefError('file', 'etc/codex.json')).toMatch(/absoluta/);
  expect(credentialRefError('secret_manager', 'vault:cauce/codex')).toBeUndefined();
  expect(credentialRefError('secret_manager', 'random:cauce/codex')).toMatch(/esquema/);
});

const draft: AccountDraft = {
  id: 'codex-steven', provider: 'codex', externalAccountId: 'org-9f21', payerTenant: 'Steven',
  label: 'Codex', credentialRefKind: 'env_path', credentialRef: 'CAUCE_CODEX_STEVEN_PATH',
  sharedWithPool: true, enabled: true,
};

it('arma el alta con el pagador y el locator, y rechaza un id que la base no aceptaría', () => {
  expect(accountDraftError(draft)).toBeUndefined();
  expect(createAccountMutation(draft)).toEqual({
    resource: 'provider_account', action: 'create', id: 'codex-steven',
    value: {
      provider: 'codex', external_account_id: 'org-9f21', payer_tenant_id: 'Steven', label: 'Codex',
      credential_ref_kind: 'env_path', credential_ref: 'CAUCE_CODEX_STEVEN_PATH',
      shared_with_pool: true, enabled: true,
    },
  });
  expect(accountDraftError({ ...draft, id: 'Codex Steven' })).toMatch(/id de cuenta/i);
  expect(accountDraftError({ ...draft, payerTenant: '' })).toMatch(/pagador/i);
});

it('el update sólo manda los tres campos mutables: identidad y locator son inmutables', () => {
  expect(updateAccountMutation('codex-steven', { label: null, sharedWithPool: false, enabled: true })).toEqual({
    resource: 'provider_account', action: 'update', id: 'codex-steven',
    value: { label: null, shared_with_pool: false, enabled: true },
  });
});

it('no reimprime el locator que el servidor devuelve en el eco de la mutación', () => {
  const preview = redactPreview({
    applied: false, dry_run: true, revision: 7,
    mutation: { resource: 'provider_account', action: 'create', id: 'codex-steven', value: { credential_ref: 'CAUCE_CODEX_STEVEN_PATH' } },
  });
  expect(preview).not.toContain('CAUCE_CODEX_STEVEN_PATH');
  expect(preview).toContain('locator no reimpreso');
});

it('lee el tenant del actor del subject firmado por el servidor y no adivina cuando falta', () => {
  expect(viewerTenant('Steven:kant')).toBe('Steven');
  expect(viewerTenant(undefined)).toBeUndefined();
  expect(viewerTenant('')).toBeUndefined();
});

function conflict(message: string): ApiError {
  return new ApiError(message, 409, 'conflict');
}

const DURABLE = 'configuration change violates a durable constraint';

it('explica que despublicar está bloqueado por el techo de otro tenant, y nombra a los prestatarios', () => {
  const context = contextFrom({
    ...snapshot,
    provider_accounts: [
      { id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex', shared_with_pool: true, enabled: true, external_account_id: 'org-9f21', credential_ref_kind: 'env_path' },
    ],
    alias_routing_ceiling: [
      { tenant_id: 'Miguel', alias: 'iza', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Miguel' },
    ],
  });
  const mutation = updateAccountMutation('codex-steven', { label: 'Codex', sharedWithPool: false, enabled: true });
  const described = describeRegistryError(conflict(DURABLE), mutation, context);

  expect(described.conflict).toBe(false);
  expect(described.message).toMatch(/alias_routing_ceiling_borrow_requires_pool/);
  expect(described.message).toMatch(/Miguel\/iza/);
  expect(described.message).not.toMatch(/durable constraint/);
});

it('explica que no se puede prestar una cuenta que su pagador no publicó al pool', () => {
  const context = contextFrom({
    ...snapshot,
    provider_accounts: [
      { id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax', shared_with_pool: false, enabled: true, external_account_id: null, credential_ref_kind: null },
    ],
  });
  const mutation = ceilingMutation('create', 'Steven', 'kant', 'minimax-pablo');
  const described = describeRegistryError(conflict(DURABLE), mutation, context);

  expect(described.message).toMatch(/la paga Pablo y NO está publicada al pool/);
  expect(described.message).toMatch(/shared_with_pool/);
});

it('atribuye el rechazo al alias ausente del registro cuando el techo apunta a un agente que no existe', () => {
  const mutation = ceilingMutation('create', 'Steven', 'fantasma', 'codex-steven');
  const described = describeRegistryError(conflict(DURABLE), mutation, contextFrom());

  expect(described.message).toMatch(/no está registrado en `agents`/);
  expect(described.message).toMatch(/alias_routing_ceiling_agent_fk/);
});

it('enumera las dos únicas causas posibles cuando el snapshot local no muestra ninguna incumplida', () => {
  const mutation = ceilingMutation('create', 'Steven', 'kant', 'codex-steven');
  const described = describeRegistryError(conflict(DURABLE), mutation, contextFrom());

  expect(described.message).toMatch(/alias_routing_ceiling_agent_fk/);
  expect(described.message).toMatch(/alias_routing_ceiling_borrow_requires_pool/);
  expect(described.message).toMatch(/actualizá y volvé a previsualizar/i);
});

it('nombra la cuenta que ya ocupa esa prioridad en el orden de fallback', () => {
  const mutation = bindingMutation('create', 'Steven', 'kant', 'codex-steven', { priority: 50, enabled: true });
  const described = describeRegistryError(conflict(DURABLE), mutation, contextFrom());

  expect(described.message).toMatch(/prioridad 50 ya la usa la cuenta «minimax-pablo»/);
  expect(described.message).toMatch(/agent_account_bindings_order_idx/);
});

it('señala la suscripción externa ya registrada en vez de repetir el error genérico', () => {
  const mutation = createAccountMutation({ ...draft, id: 'codex-otro' });
  const described = describeRegistryError(conflict(DURABLE), mutation, contextFrom());

  expect(described.message).toMatch(/ya está registrada como «codex-steven»/);
  expect(described.message).toMatch(/UNIQUE \(provider, external_account_id\)/);
});

it('explica que el registro es hub-only ante un 403', () => {
  const described = describeRegistryError(
    new ApiError('configuration resource is outside the actor tenant', 403, 'forbidden'),
    ceilingMutation('create', 'Steven', 'kant', 'codex-steven'),
    contextFrom(),
  );
  expect(described.message).toMatch(/hub-only/);
  expect(described.message).toMatch(/plata de otro tenant/);
});

it('explica la inmutabilidad en vez de dejar pasar el mensaje del store', () => {
  const described = describeRegistryError(
    conflict('provider_account identity and credential rotation require delete and create, not update'),
    updateAccountMutation('codex-steven', { label: 'x', sharedWithPool: true, enabled: true }),
    contextFrom(),
  );
  expect(described.message).toMatch(/inmutables/);
  expect(described.message).toMatch(/dar de baja y volver a crear/);
});

it('deja intacto el mensaje de choque optimista de revisión', () => {
  const described = describeRegistryError(
    conflict('configuration revision changed: expected 7, current 9'),
    ceilingMutation('create', 'Steven', 'kant', 'codex-steven'),
    contextFrom(),
  );
  expect(described.conflict).toBe(true);
  expect(described.message).toMatch(/revisión 7 y el servidor ya va por la 9/);
});
