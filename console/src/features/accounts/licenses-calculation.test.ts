import { describe, it, expect } from 'vitest';
import {
  accountConsumption,
} from './licenses';
import type { QuotaSnapshot, QuotaThresholds } from '../../api/types';

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
          age_seconds: 400,
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
                  remaining_percent: null,
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
