import { configCollections } from './collections';

it('publica las colecciones que el snapshot trae, no una lista fija de seis', () => {
  const collections = configCollections({
    revision: 7, observed_at: '2026-07-26T00:00:00.000Z',
    tenants: [{ id: 'Steven' }], rooms: [], memberships: [], acl_edges: [],
    harness_definitions: [], role_policies: [],
    chain_policies: [{ id: 'default', cycle_cut_enabled: true }],
    egress_destinations: [{ tenant_id: 'Miguel', alias: 'janus', handle: 'steven_dm' }],
    agents: [], provider_accounts: [], alias_routing_ceiling: [], agent_account_bindings: [],
    revisions: [{ id: '7' }],
  });

  // Metadata and the three account-registry collections have dedicated authorities and must not
  // appear as duplicate cards of effective data here.
  expect(collections.map((collection) => collection.key)).toEqual([
    'tenants', 'rooms', 'memberships', 'acl_edges', 'harness_definitions', 'role_policies',
    'chain_policies', 'egress_destinations', 'agents',
  ]);
  expect(collections.find((collection) => collection.key === 'chain_policies')).toMatchObject({
    title: 'Chain visibility policy', rows: [{ id: 'default', cycle_cut_enabled: true }],
  });
  expect(collections.find((collection) => collection.key === 'egress_destinations')?.title)
    .toBe('Proactive egress allowlist');
});

it('deja provider_accounts, techos y bindings exclusivamente en Cuentas y cuotas', () => {
  const collections = configCollections({
    revision: 1,
    provider_accounts: [{ id: 'codex-steven' }],
    alias_routing_ceiling: [{ tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven' }],
    agent_account_bindings: [{ tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven' }],
  });
  expect(collections.map((collection) => collection.key)).not.toEqual(expect.arrayContaining([
    'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings',
  ]));
});

it('distingue una clave ausente de una lista vacía', () => {
  const collections = configCollections({ revision: 1, tenants: [], rooms: [{ id: 'grp.steven' }] });
  const byKey = new Map(collections.map((collection) => [collection.key, collection]));

  // Zero known rows.
  expect(byKey.get('tenants')?.rows).toEqual([]);
  // The gateway did not publish the key: data unavailable, which is not the same as zero rows.
  expect(byKey.get('chain_policies')?.rows).toBeUndefined();
  expect(byKey.get('agents')?.rows).toBeUndefined();
});

it('muestra una colección que el servidor agregue sin que la consola la conozca', () => {
  const collections = configCollections({
    revision: 1, tenants: [], future_widgets: [{ id: 'nuevo' }],
  } as never);

  const extra = collections.find((collection) => collection.key === 'future_widgets');
  expect(extra).toMatchObject({ title: 'future_widgets', rows: [{ id: 'nuevo' }] });
  // New keys go at the end, after the known ones and in the server's order.
  expect(collections[collections.length - 1]?.key).toBe('future_widgets');
});

it('no convierte agent_profiles en otra pantalla genérica para editar contexto', () => {
  const collections = configCollections({
    revision: 1,
    tenants: [],
    agent_profiles: [{ tenant_id: 'Steven', alias: 'kant', role_summary: 'Coordina la flota.' }],
    future_widgets: [{ id: 'nuevo' }],
  } as never);

  expect(collections.some((collection) => collection.key === 'agent_profiles')).toBe(false);
  expect(collections.find((collection) => collection.key === 'future_widgets'))
    .toMatchObject({ rows: [{ id: 'nuevo' }] });
});

it('no inventa colecciones cuando todavía no hay snapshot', () => {
  expect(configCollections(undefined)).toEqual([]);
});

it('no hereda un título del prototipo para una clave llamada como un método de Object', () => {
  const collections = configCollections({ revision: 1, toString: [{ id: 'raro' }] } as never);
  expect(collections.find((collection) => collection.key === 'toString')?.title).toBe('toString');
});
