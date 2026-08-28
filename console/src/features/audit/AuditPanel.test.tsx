import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Profiler } from 'react';
import { AuditPanel } from './AuditPanel';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

const event = (id: string, decision: 'allow' | 'deny' | 'info' = 'allow') => ({
  event_id: id,
  at: '2026-08-26T08:00:00.000Z',
  tenant_id: id === '3' ? 'Miguel' : 'Steven',
  actor_alias: id === '3' ? 'atlas' : 'kant',
  action: id === '5' ? 'fleet.reconcile' : `audit.event.${id}`,
  decision,
  request_id: null,
  trace_id: `trace-${id}`,
  summary: JSON.stringify({ state: id === '5' ? 'converged' : 'done' }),
});

describe('AuditPanel keyset pagination', () => {
  it('never publishes a false empty snapshot while installing the first page', async () => {
    server.use(http.get('*/v3/console/audit', () => HttpResponse.json({
      items: [event('1')],
      next_cursor: null,
    })));
    const committedFrames: string[] = [];

    renderWithApi(
      <Profiler id="audit-first-page" onRender={() => committedFrames.push(document.body.textContent)}>
        <AuditPanel query="" onQuery={() => undefined} />
      </Profiler>,
    );

    expect(await screen.findByText('audit.event.1')).toBeInTheDocument();
    expect(screen.getByText('1 visibles de 1')).toBeInTheDocument();
    expect(committedFrames.some((frame) => frame.includes('0 visibles de 0'))).toBe(false);
  });

  it('loads older pages without duplicates and renders info as a neutral decision', async () => {
    const queries: string[] = [];
    server.use(http.get('*/v3/console/audit', ({ request }) => {
      const url = new URL(request.url);
      queries.push(url.search);
      if (url.searchParams.get('before') === '4') {
        return HttpResponse.json({ items: [event('3'), event('2')], next_cursor: null });
      }
      return HttpResponse.json({ items: [event('5', 'info'), event('4')], next_cursor: '4' });
    }));
    const user = userEvent.setup();
    renderWithApi(<AuditPanel query="" onQuery={() => undefined} />);

    const info = (await screen.findByText('fleet.reconcile')).closest('article');
    expect(info).not.toBeNull();
    if (info) {
      expect(within(info).getByText('info')).toBeInTheDocument();
      expect(info.querySelector('.audit-icon.info')).not.toBeNull();
    }
    expect(screen.getByText('2 visibles de 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cargar anteriores' }));
    expect(await screen.findByText('audit.event.3')).toBeInTheDocument();
    expect(screen.getByText('audit.event.2')).toBeInTheDocument();
    expect(screen.getByText('4 visibles de 4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cargar anteriores' })).not.toBeInTheDocument();
    expect(queries).toEqual(['?limit=100', '?limit=100&before=4']);
  });

  it('retains the loaded snapshot and fails visibly on a repeated/non-progressing cursor', async () => {
    server.use(http.get('*/v3/console/audit', ({ request }) => {
      const before = new URL(request.url).searchParams.get('before');
      return before === null
        ? HttpResponse.json({ items: [event('5'), event('4')], next_cursor: '4' })
        : HttpResponse.json({ items: [event('4')], next_cursor: '4' });
    }));
    const user = userEvent.setup();
    renderWithApi(<AuditPanel query="" onQuery={() => undefined} />);

    await screen.findByText('audit.event.4');
    await user.click(screen.getByRole('button', { name: 'Cargar anteriores' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/repitió o adelantó el cursor/i);
    expect(screen.getByText('2 visibles de 2')).toBeInTheDocument();
    expect(screen.getAllByText('audit.event.4')).toHaveLength(1);
  });

  it('keeps current rows and allows retry after an older-page transport failure', async () => {
    let olderAttempts = 0;
    server.use(http.get('*/v3/console/audit', ({ request }) => {
      const before = new URL(request.url).searchParams.get('before');
      if (before === null) return HttpResponse.json({ items: [event('5')], next_cursor: '5' });
      olderAttempts += 1;
      if (olderAttempts === 1) return HttpResponse.json({ error: 'down' }, { status: 503 });
      return HttpResponse.json({ items: [event('4')], next_cursor: null });
    }));
    const user = userEvent.setup();
    renderWithApi(<AuditPanel query="" onQuery={() => undefined} />);

    await screen.findByText('fleet.reconcile');
    await user.click(screen.getByRole('button', { name: 'Cargar anteriores' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudieron cargar/i);
    expect(screen.getByText('fleet.reconcile')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
    expect(await screen.findByText('audit.event.4')).toBeInTheDocument();
    expect(olderAttempts).toBe(2);
  });
});
