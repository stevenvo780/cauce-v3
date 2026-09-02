import { render, screen, within } from '@testing-library/react';
import { AccountRoutingDetail } from './AccountRoutingDetail';
import type { AccountRouteEntry, AccountRouteProjection } from './registry';

function agent(alias: string, containerName: string | null = `claw-${alias}`) {
  return {
    tenantId: 'Steven', alias, harnessId: 'claude', displayName: alias, enabled: true, containerName, runtimeUser: null,
  };
}

function ceiling(alias: string, createdByTenant: string | null = null, borrowed = false) {
  return {
    tenantId: 'Steven', alias, accountId: 'acc-1', accountPayerTenant: 'Steven', createdByTenant, borrowed,
  };
}

function entry(overrides: Partial<AccountRouteEntry['cell']> & { alias: string; createdByTenant?: string | null }): AccountRouteEntry {
  const { alias, createdByTenant, ...cell } = overrides;
  return {
    agent: agent(alias),
    ceiling: ceiling(alias, createdByTenant ?? null),
    cell: { accountId: 'acc-1', state: 'bound-enabled', borrowed: false, priority: null, rank: null, ...cell },
  };
}

function route(entries: AccountRouteEntry[]): AccountRouteProjection {
  return { accountId: 'acc-1', entries };
}

/**
 * ADR-006 dropped `purpose` (primary/fallback) entirely: `agent_account_bindings` is only the
 * fallback order within the ceiling (`priority`, lowest first), and even priority 0 never runs on
 * attempt 1 — the pool only intervenes on retries. A "PRIMARIA" badge would claim a distinguished
 * role the schema no longer has.
 */
it('labels a priority-0 binding as the first fallback rank, never as PRIMARIA', () => {
  render(<AccountRoutingDetail
    accountId="acc-1"
    quotas={undefined}
    route={route([entry({ alias: 'zeus', priority: 0, rank: 1, state: 'bound-enabled' })])}
  />);
  expect(screen.getByText('FALLBACK #1')).toBeInTheDocument();
  expect(screen.queryByText(/PRIMARIA/i)).not.toBeInTheDocument();
  expect(screen.getByText('0')).toBeInTheDocument();
});

it('orders fallback ranks by priority regardless of which one is priority 0', () => {
  render(<AccountRoutingDetail
    accountId="acc-1"
    quotas={undefined}
    route={route([
      entry({ alias: 'kant', priority: 1, rank: 2, state: 'bound-enabled' }),
      entry({ alias: 'zeus', priority: 0, rank: 1, state: 'bound-enabled' }),
    ])}
  />);
  const filaZeus = screen.getByText('zeus').closest('li');
  const filaKant = screen.getByText('kant').closest('li');
  expect(filaZeus).not.toBeNull();
  expect(filaKant).not.toBeNull();
  expect(within(filaZeus as HTMLElement).getByText('FALLBACK #1')).toBeInTheDocument();
  expect(within(filaKant as HTMLElement).getByText('FALLBACK #2')).toBeInTheDocument();
  expect(screen.queryByText(/PRIMARIA/i)).not.toBeInTheDocument();
});

it('marks a disabled binding as FALLBACK INACTIVO, not as ranked', () => {
  render(<AccountRoutingDetail
    accountId="acc-1"
    quotas={undefined}
    route={route([entry({ alias: 'zeus', priority: 0, rank: null, state: 'bound-disabled' })])}
  />);
  expect(screen.getByText('FALLBACK INACTIVO')).toBeInTheDocument();
  expect(screen.queryByText(/PRIMARIA/i)).not.toBeInTheDocument();
});

it('lists ceiling-only aliases without a fallback badge, under the routing ceiling', () => {
  render(<AccountRoutingDetail
    accountId="acc-1"
    quotas={undefined}
    route={route([entry({ alias: 'kant', state: 'ceiling-only', createdByTenant: 'Steven' })])}
  />);
  expect(screen.getByText('Ningún alias la tiene configurada como fallback.')).toBeInTheDocument();
  expect(screen.getByText(/puede alcanzar esta cuenta/)).toBeInTheDocument();
  expect(screen.getByText(/otorgado por Steven/)).toBeInTheDocument();
});

it('shows nothing when no alias reaches the account', () => {
  render(<AccountRoutingDetail accountId="acc-1" quotas={undefined} route={route([])} />);
  expect(screen.getByText('Ningún alias la tiene configurada como fallback.')).toBeInTheDocument();
  expect(screen.queryByText('Techo de ruteo')).not.toBeInTheDocument();
});
