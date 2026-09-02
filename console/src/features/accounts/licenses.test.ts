import { describe, it, expect } from 'vitest';
import {
  formatResetIn,
  freshness,
  orphans,
  type Collector,
} from './licenses';
import type { QuotaSnapshot, QuotaThresholds } from '../../api/types';
import { UNKNOWN } from '../../lib';
import type { AccountBinding, AgentRegistration, ProviderAccount } from './registry';

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

describe('orphans', () => {
  it('encuentra cuentas sin datos de cuota', () => {
    const accounts: ProviderAccount[] = [
      {
        id: 'codex-steven',
        provider: 'codex',
        payerTenant: 'Steven',
        label: 'Steven',
        sharedWithPool: true,
        enabled: true,
        externalAccountId: null,
        credentialRefKind: null,
        payerFields: 'redacted',
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'gemini-steven',
        provider: 'gemini',
        payerTenant: 'Steven',
        label: 'Steven Gemini',
        sharedWithPool: true,
        enabled: true,
        externalAccountId: null,
        credentialRefKind: null,
        payerFields: 'redacted',
        createdAt: null,
        updatedAt: null,
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
    const bindings: AccountBinding[] = [];
    const agents: AgentRegistration[] = [];

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
    const bindings: AccountBinding[] = [];
    const agents: AgentRegistration[] = [];

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
    const bindings: AccountBinding[] = [
      {
        tenantId: 'Steven',
        agentAlias: 'kant',
        accountId: 'codex-steven',
        priority: 0,
        enabled: true,
      },
    ];
    const agents: AgentRegistration[] = [
      {
        tenantId: 'Steven',
        alias: 'kant',
        harnessId: 'harness-1',
        displayName: 'Kant',
        enabled: true,
        containerName: 'kant-primary',
        runtimeUser: null,
      },
      {
        tenantId: 'Steven',
        alias: 'orphan',
        harnessId: 'harness-2',
        displayName: 'Orphan',
        enabled: true,
        containerName: 'orphan-solo',
        runtimeUser: null,
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
  const agents: AgentRegistration[] = [
    {
      tenantId: 'Steven', alias: 'claude', harnessId: 'claude', displayName: 'Claude de Steven',
      enabled: true, containerName: 'claw-steven-claude', runtimeUser: null,
    },
    {
      tenantId: 'Miguel', alias: 'claude', harnessId: 'claude', displayName: 'Claude de Miguel',
      enabled: true, containerName: 'claw-miguel-claude', runtimeUser: null,
    },
  ];

  it('el binding de un cliente no tapa al homónimo del otro, que sí está huérfano', () => {
    const bindings: AccountBinding[] = [
      { tenantId: 'Steven', agentAlias: 'claude', accountId: 'claude-max', priority: 0, enabled: true },
    ];

    const result = orphans([], quotas, bindings, agents);
    expect(result.agentsWithoutBindings.map((agent) => agent.tenantId)).toEqual(['Miguel']);
  });

  it('con los dos atados, ninguno queda como huérfano', () => {
    // Negative control: without it, a version that reported everyone as an orphan would pass the test above.
    const bindings: AccountBinding[] = [
      { tenantId: 'Miguel', agentAlias: 'claude', accountId: 'claude-max', priority: 0, enabled: true },
      { tenantId: 'Steven', agentAlias: 'claude', accountId: 'claude-max', priority: 1, enabled: true },
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
