import { describe, it, expect } from 'vitest';
import {
  accountAssignments,
  extractAgents,
  extractBindings,
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
    expect(result.label).toContain('10m');
    expect(result.label).not.toContain('-');
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

  /*
   * The fleet repeats aliases across clients (`claude` lives under more than one). Crossing binding against
   * agent by alias alone showed the account as assigned to the homonym of ANOTHER client: a wrong container
   * name, a wrong display name, and no way to tell from the screen.
   */
  it('cruza por tenant y alias: con el alias repetido no trae al agente del otro cliente', () => {
    const homonimos: Agent[] = [
      {
        tenant_id: 'Steven', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Steven',
        enabled: true, container_name: 'claw-steven-claude',
      },
      {
        tenant_id: 'Miguel', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Miguel',
        enabled: true, container_name: 'claw-miguel-claude',
      },
    ];
    // The binding is the FIRST agent's, so an index by alias alone —where the last one registered wins— brings
    // back the other client's homonym. Otherwise this would pass by accident.
    const bindings: AgentAccountBinding[] = [
      { tenant_id: 'Steven', agent_alias: 'claude', account_id: 'claude-max', priority: 0, enabled: true },
    ];

    const result = accountAssignments('claude-max', bindings, homonimos);
    expect(result).toHaveLength(1);
    expect(result[0].tenant_id).toBe('Steven');
    expect(result[0].display_name).toBe('Claude de Steven');
    expect(result[0].container_name).toBe('claw-steven-claude');
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

describe('orphans, con el alias repetido entre clientes', () => {
  const quotas: QuotaSnapshot = {
    observed_at: null, thresholds: null, collectors: [], providers: [],
    unbound_groups: [], paused_accounts: [],
  };
  const agents: Agent[] = [
    {
      tenant_id: 'Steven', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Steven',
      enabled: true, container_name: 'claw-steven-claude',
    },
    {
      tenant_id: 'Miguel', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Miguel',
      enabled: true, container_name: 'claw-miguel-claude',
    },
  ];

  it('el binding de un cliente no tapa al homónimo del otro, que sí está huérfano', () => {
    const bindings: AgentAccountBinding[] = [
      { tenant_id: 'Steven', agent_alias: 'claude', account_id: 'claude-max', priority: 0, enabled: true },
    ];

    const result = orphans([], quotas, bindings, agents);
    expect(result.agentsWithoutBindings.map((agent) => agent.tenant_id)).toEqual(['Miguel']);
  });

  it('con los dos atados, ninguno queda como huérfano', () => {
    // Negative control: without it, a version that reported everyone as an orphan would pass the test above.
    const bindings: AgentAccountBinding[] = [
      { tenant_id: 'Miguel', agent_alias: 'claude', account_id: 'claude-max', priority: 0, enabled: true },
      { tenant_id: 'Steven', agent_alias: 'claude', account_id: 'claude-max', priority: 1, enabled: true },
    ];

    expect(orphans([], quotas, bindings, agents).agentsWithoutBindings).toEqual([]);
  });
});

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
});
