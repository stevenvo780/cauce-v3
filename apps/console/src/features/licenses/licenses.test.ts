import { describe, it, expect } from 'vitest';
import {
  accountAssignments,
  accountConsumption,
  extractAgents,
  extractBindings,
  extractCollectors,
  extractCeiling,
  extractProviderAccounts,
  formatResetIn,
  freshness,
  orphans,
  type Agent,
  type AgentAccountBinding,
  type Collector,
  type ProviderAccount,
} from './licenses';
import type { ConfigurationSnapshot, QuotaSnapshot, QuotaThresholds } from '../../api/types';
import { UNKNOWN } from '../../lib';

// ─────────────────────────────────────────────────────────────────────────────────────
// Freshness tests

describe('freshness', () => {
  const thresholds: QuotaThresholds = {
    stale_after_seconds: 300,
    warn_remaining_percent: 20,
    critical_remaining_percent: 5,
  };
  const now = 1000000;

  it('devuelve "absent" si no hay collector', () => {
    const result = freshness(null, thresholds, now);
    expect(result.state).toBe('absent');
    expect(result.ageSeconds).toBeNull();
  });

  it('devuelve "stale" si el collector tiene stale=true', () => {
    const collector: Collector = {
      host: 'localhost',
      captured_at: null,
      received_at: null,
      age_seconds: 600,
      stale: true,
      provider_count: 1,
      window_count: 1,
    };
    const result = freshness(collector, thresholds, now);
    expect(result.state).toBe('stale');
    expect(result.ageSeconds).toBe(600);
  });

  it('devuelve "stale" si age_seconds > stale_after_seconds', () => {
    const collector: Collector = {
      host: 'localhost',
      captured_at: null,
      received_at: null,
      age_seconds: 400,
      stale: false,
      provider_count: 1,
      window_count: 1,
    };
    const result = freshness(collector, thresholds, now);
    expect(result.state).toBe('stale');
    expect(result.ageSeconds).toBe(400);
  });

  it('devuelve "fresh" si age_seconds <= stale_after_seconds', () => {
    const collector: Collector = {
      host: 'localhost',
      captured_at: null,
      received_at: null,
      age_seconds: 100,
      stale: false,
      provider_count: 1,
      window_count: 1,
    };
    const result = freshness(collector, thresholds, now);
    expect(result.state).toBe('fresh');
    expect(result.ageSeconds).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Account consumption tests — HONESTIDAD CRÍTICA

describe('accountConsumption', () => {
  const thresholds: QuotaThresholds = {
    stale_after_seconds: 300,
    warn_remaining_percent: 20,
    critical_remaining_percent: 5,
  };
  const now = 1000000;

  it('devuelve available=false si no hay collectors en absoluto', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds,
      collectors: [],
      providers: [],
      unbound_groups: [],
      paused_accounts: [],
    };
    const result = accountConsumption('codex-steven', quotas, thresholds, now);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('Ningún recolector');
    expect(result.windows).toHaveLength(0);
  });

  it('devuelve "?" para porcentajes si la sonda está caduca', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds,
      collectors: [
        {
          host: 'kratos',
          collector_tenant: null,
          collector_alias: null,
          captured_at: null,
          received_at: null,
          age_seconds: 400, // > 300 = caduco
          stale: false,
          schema_version: 1,
          app_version: null,
          provider_count: 1,
          window_count: 1,
        },
      ],
      providers: [
        {
          host: 'kratos',
          provider: 'codex',
          ok: true,
          available: true,
          kind: 'token',
          source: null,
          plan: 'gpt-5.6-sol',
          note: null,
          effective_remaining_percent: 50,
          observed_at: null,
          age_seconds: 400,
          available_groups: null,
          limiting_groups: null,
          severity: 'ok',
          groups: [
            {
              group_key: 'codex-steven@claude',
              limit_id: null,
              account_id: 'codex-steven',
              account_label: 'Steven',
              account_provider: 'codex',
              payer_tenant_id: 'grp.steven',
              paused_until: null,
              paused_reason: null,
              min_remaining_percent: 50,
              severity: 'ok',
              windows: [
                {
                  window_key: 'session',
                  label: 'Sesión',
                  used_percent: 30,
                  remaining_percent: 70,
                  used_units: null,
                  limit_units: null,
                  window_minutes: 60,
                  reset_at: null,
                  reset_in_seconds: 3600,
                  status: null,
                  family: null,
                  model: null,
                  severity: 'ok',
                  history: null,
                },
              ],
            },
          ],
        },
      ],
      unbound_groups: [],
      paused_accounts: [],
    };

    const result = accountConsumption('codex-steven', quotas, thresholds, now);
    expect(result.available).toBe(true);
    // ¡CRÍTICO! La sonda está caduca, así que los porcentajes DEBEN ser "?"
    expect(result.windows[0].used_percent).toBe('?');
    expect(result.windows[0].remaining_percent).toBe('?');
  });

  it('devuelve "?" si remaining_percent es null', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds,
      collectors: [
        {
          host: 'kratos',
          collector_tenant: null,
          collector_alias: null,
          captured_at: null,
          received_at: null,
          age_seconds: 50, // fresco
          stale: false,
          schema_version: 1,
          app_version: null,
          provider_count: 1,
          window_count: 1,
        },
      ],
      providers: [
        {
          host: 'kratos',
          provider: 'codex',
          ok: true,
          available: true,
          kind: 'token',
          source: null,
          plan: 'gpt-5.6-sol',
          note: null,
          effective_remaining_percent: null,
          observed_at: null,
          age_seconds: 50,
          available_groups: null,
          limiting_groups: null,
          severity: 'unknown',
          groups: [
            {
              group_key: 'codex-steven@claude',
              limit_id: null,
              account_id: 'codex-steven',
              account_label: 'Steven',
              account_provider: 'codex',
              payer_tenant_id: 'grp.steven',
              paused_until: null,
              paused_reason: null,
              min_remaining_percent: null,
              severity: 'unknown',
              windows: [
                {
                  window_key: 'session',
                  label: 'Sesión',
                  used_percent: 30,
                  remaining_percent: null, // ← null
                  used_units: null,
                  limit_units: null,
                  window_minutes: 60,
                  reset_at: null,
                  reset_in_seconds: 3600,
                  status: null,
                  family: null,
                  model: null,
                  severity: 'unknown',
                  history: null,
                },
              ],
            },
          ],
        },
      ],
      unbound_groups: [],
      paused_accounts: [],
    };

    const result = accountConsumption('codex-steven', quotas, thresholds, now);
    expect(result.available).toBe(true);
    // ¡CRÍTICO! remaining_percent es null, así que debe ser "?"
    expect(result.windows[0].remaining_percent).toBe('?');
  });

  it('devuelve números reales si la sonda está fresca y los datos son válidos', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds,
      collectors: [
        {
          host: 'kratos',
          collector_tenant: null,
          collector_alias: null,
          captured_at: null,
          received_at: null,
          age_seconds: 50, // fresco
          stale: false,
          schema_version: 1,
          app_version: null,
          provider_count: 1,
          window_count: 1,
        },
      ],
      providers: [
        {
          host: 'kratos',
          provider: 'codex',
          ok: true,
          available: true,
          kind: 'token',
          source: null,
          plan: 'gpt-5.6-sol',
          note: null,
          effective_remaining_percent: 50,
          observed_at: null,
          age_seconds: 50,
          available_groups: null,
          limiting_groups: null,
          severity: 'ok',
          groups: [
            {
              group_key: 'codex-steven@claude',
              limit_id: null,
              account_id: 'codex-steven',
              account_label: 'Steven',
              account_provider: 'codex',
              payer_tenant_id: 'grp.steven',
              paused_until: null,
              paused_reason: null,
              min_remaining_percent: 50,
              severity: 'ok',
              windows: [
                {
                  window_key: 'session',
                  label: 'Sesión',
                  used_percent: 30,
                  remaining_percent: 70,
                  used_units: null,
                  limit_units: null,
                  window_minutes: 60,
                  reset_at: null,
                  reset_in_seconds: 3600,
                  status: null,
                  family: null,
                  model: null,
                  severity: 'ok',
                  history: null,
                },
              ],
            },
          ],
        },
      ],
      unbound_groups: [],
      paused_accounts: [],
    };

    const result = accountConsumption('codex-steven', quotas, thresholds, now);
    expect(result.available).toBe(true);
    expect(result.windows[0].used_percent).toBe(30);
    expect(result.windows[0].remaining_percent).toBe(70);
  });

  it('devuelve plan correctamente', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds,
      collectors: [
        {
          host: 'kratos',
          collector_tenant: null,
          collector_alias: null,
          captured_at: null,
          received_at: null,
          age_seconds: 50,
          stale: false,
          schema_version: 1,
          app_version: null,
          provider_count: 1,
          window_count: 1,
        },
      ],
      providers: [
        {
          host: 'kratos',
          provider: 'codex',
          ok: true,
          available: true,
          kind: 'token',
          source: null,
          plan: 'gpt-5.6-terra',
          note: null,
          effective_remaining_percent: 50,
          observed_at: null,
          age_seconds: 50,
          available_groups: null,
          limiting_groups: null,
          severity: 'ok',
          groups: [
            {
              group_key: 'codex-steven@claude',
              limit_id: null,
              account_id: 'codex-steven',
              account_label: 'Steven',
              account_provider: 'codex',
              payer_tenant_id: 'grp.steven',
              paused_until: null,
              paused_reason: null,
              min_remaining_percent: 50,
              severity: 'ok',
              windows: [
                {
                  window_key: 'session',
                  label: 'Sesión',
                  used_percent: 30,
                  remaining_percent: 70,
                  used_units: null,
                  limit_units: null,
                  window_minutes: 60,
                  reset_at: null,
                  reset_in_seconds: 3600,
                  status: null,
                  family: null,
                  model: null,
                  severity: 'ok',
                  history: null,
                },
              ],
            },
          ],
        },
      ],
      unbound_groups: [],
      paused_accounts: [],
    };

    const result = accountConsumption('codex-steven', quotas, thresholds, now);
    expect(result.plan).toBe('gpt-5.6-terra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Account assignments tests

describe('accountAssignments', () => {
  const agents: Agent[] = [
    {
      tenant_id: 'grp.steven',
      alias: 'kant',
      harness_id: 'harness-1',
      display_name: 'Kant',
      enabled: true,
      container_name: 'kant-primary',
    },
    {
      tenant_id: 'grp.steven',
      alias: 'socrates',
      harness_id: 'harness-2',
      display_name: 'Socrates',
      enabled: true,
      container_name: 'socrates-backup',
    },
  ];

  it('ordena por prioridad y marca primary', () => {
    const bindings: AgentAccountBinding[] = [
      {
        tenant_id: 'grp.steven',
        agent_alias: 'socrates',
        account_id: 'codex-steven',
        priority: 1,
        enabled: true,
      },
      {
        tenant_id: 'grp.steven',
        agent_alias: 'kant',
        account_id: 'codex-steven',
        priority: 0,
        enabled: true,
      },
    ];

    const result = accountAssignments('codex-steven', bindings, agents);
    expect(result).toHaveLength(2);
    expect(result[0].alias).toBe('kant');
    expect(result[0].isPrimary).toBe(true);
    expect(result[1].alias).toBe('socrates');
    expect(result[1].isPrimary).toBe(false);
  });

  it('marca enabled=false como inactivo', () => {
    const bindings: AgentAccountBinding[] = [
      {
        tenant_id: 'grp.steven',
        agent_alias: 'kant',
        account_id: 'codex-steven',
        priority: 0,
        enabled: false,
      },
    ];

    const result = accountAssignments('codex-steven', bindings, agents);
    expect(result[0].enabled).toBe(false);
  });

  it('incluye container_name del agente', () => {
    const bindings: AgentAccountBinding[] = [
      {
        tenant_id: 'grp.steven',
        agent_alias: 'kant',
        account_id: 'codex-steven',
        priority: 0,
        enabled: true,
      },
    ];

    const result = accountAssignments('codex-steven', bindings, agents);
    expect(result[0].container_name).toBe('kant-primary');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Orphans tests

describe('orphans', () => {
  it('encuentra cuentas sin datos de cuota', () => {
    const accounts: ProviderAccount[] = [
      {
        id: 'codex-steven',
        provider: 'codex',
        payer_tenant_id: 'grp.steven',
        label: 'Steven',
        shared_with_pool: true,
        enabled: true,
        external_account_id: null,
        credential_ref_kind: null,
        created_at: null,
        updated_at: null,
      },
      {
        id: 'gemini-steven',
        provider: 'gemini',
        payer_tenant_id: 'grp.steven',
        label: 'Steven Gemini',
        shared_with_pool: true,
        enabled: true,
        external_account_id: null,
        credential_ref_kind: null,
        created_at: null,
        updated_at: null,
      },
    ];
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds: null,
      collectors: [],
      providers: [
        {
          host: 'kratos',
          provider: 'codex',
          ok: true,
          available: true,
          kind: null,
          source: null,
          plan: null,
          note: null,
          effective_remaining_percent: null,
          observed_at: null,
          age_seconds: null,
          available_groups: null,
          limiting_groups: null,
          severity: null,
          groups: [
            {
              group_key: 'codex-steven@claude',
              limit_id: null,
              account_id: 'codex-steven',
              account_label: null,
              account_provider: null,
              payer_tenant_id: null,
              paused_until: null,
              paused_reason: null,
              min_remaining_percent: null,
              severity: null,
              windows: [],
            },
          ],
        },
      ],
      unbound_groups: [],
      paused_accounts: [],
    };
    const bindings: AgentAccountBinding[] = [];
    const agents: Agent[] = [];

    const result = orphans(accounts, quotas, bindings, agents);
    expect(result.accountsWithoutQuotas).toHaveLength(1);
    expect(result.accountsWithoutQuotas[0].id).toBe('gemini-steven');
  });

  it('encuentra grupos sin cuenta del registro', () => {
    const accounts: ProviderAccount[] = [];
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds: null,
      collectors: [],
      providers: [],
      unbound_groups: [
        {
          host: 'kratos',
          provider: 'codex',
          group_key: 'codex-unknown@claude',
          window_count: 1,
          reason: 'No bound to any account',
          detail: 'Account ID not in registry',
        },
      ],
      paused_accounts: [],
    };
    const bindings: AgentAccountBinding[] = [];
    const agents: Agent[] = [];

    const result = orphans(accounts, quotas, bindings, agents);
    expect(result.unboundGroups).toHaveLength(1);
    expect(result.unboundGroups[0].group_key).toBe('codex-unknown@claude');
  });

  it('encuentra agentes sin bindings', () => {
    const accounts: ProviderAccount[] = [];
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds: null,
      collectors: [],
      providers: [],
      unbound_groups: [],
      paused_accounts: [],
    };
    const bindings: AgentAccountBinding[] = [
      {
        tenant_id: 'grp.steven',
        agent_alias: 'kant',
        account_id: 'codex-steven',
        priority: 0,
        enabled: true,
      },
    ];
    const agents: Agent[] = [
      {
        tenant_id: 'grp.steven',
        alias: 'kant',
        harness_id: 'harness-1',
        display_name: 'Kant',
        enabled: true,
        container_name: 'kant-primary',
      },
      {
        tenant_id: 'grp.steven',
        alias: 'orphan',
        harness_id: 'harness-2',
        display_name: 'Orphan',
        enabled: true,
        container_name: 'orphan-solo',
      },
    ];

    const result = orphans(accounts, quotas, bindings, agents);
    expect(result.agentsWithoutBindings).toHaveLength(1);
    expect(result.agentsWithoutBindings[0].alias).toBe('orphan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Formatter tests

describe('formatResetIn', () => {
  it('formatea segundos positivos como "en ..."', () => {
    expect(formatResetIn(3600)).toContain('en');
    expect(formatResetIn(3600)).toContain('1h');
  });

  it('formatea segundos negativos como "hace ..."', () => {
    expect(formatResetIn(-600)).toContain('hace');
  });

  it('devuelve UNKNOWN para null', () => {
    expect(formatResetIn(null)).toBe(UNKNOWN);
  });

  it('devuelve UNKNOWN para Infinity', () => {
    expect(formatResetIn(Infinity)).toBe(UNKNOWN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Extractors tests

describe('extractors', () => {
  it('extrae provider_accounts correctamente', () => {
    const config: ConfigurationSnapshot = {
      revision: null,
      observed_at: null,
      tenants: null,
      rooms: null,
      memberships: null,
      acl_edges: null,
      harness_definitions: null,
      role_policies: null,
      chain_policies: null,
      egress_destinations: null,
      agents: null,
      provider_accounts: [
        {
          id: 'codex-steven',
          provider: 'codex',
          payer_tenant_id: 'grp.steven',
          label: 'Steven',
          shared_with_pool: true,
          enabled: true,
          external_account_id: null,
          credential_ref_kind: 'env_path',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      alias_routing_ceiling: null,
      agent_account_bindings: null,
      revisions: null,
    };

    const result = extractProviderAccounts(config);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('codex-steven');
    expect(result[0].provider).toBe('codex');
  });

  it('devuelve array vacío si no hay datos', () => {
    const config: ConfigurationSnapshot = {
      revision: null,
      observed_at: null,
      tenants: null,
      rooms: null,
      memberships: null,
      acl_edges: null,
      harness_definitions: null,
      role_policies: null,
      chain_policies: null,
      egress_destinations: null,
      agents: null,
      provider_accounts: null,
      alias_routing_ceiling: null,
      agent_account_bindings: null,
      revisions: null,
    };

    expect(extractProviderAccounts(config)).toEqual([]);
    expect(extractAgents(config)).toEqual([]);
    expect(extractBindings(config)).toEqual([]);
    expect(extractCeiling(config)).toEqual([]);
  });

  it('extrae collectors correctamente', () => {
    const quotas: QuotaSnapshot = {
      observed_at: null,
      thresholds: null,
      collectors: [
        {
          host: 'kratos',
          collector_tenant: null,
          collector_alias: null,
          captured_at: '2026-01-01T00:00:00Z',
          received_at: '2026-01-01T00:00:10Z',
          age_seconds: 50,
          stale: false,
          schema_version: 1,
          app_version: '1.0',
          provider_count: 1,
          window_count: 1,
        },
      ],
      providers: [],
      unbound_groups: [],
      paused_accounts: [],
    };

    const result = extractCollectors(quotas);
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe('kratos');
    expect(result[0].age_seconds).toBe(50);
  });
});
