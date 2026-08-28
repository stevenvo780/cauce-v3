import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Profiler } from 'react';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { OperationalDlqPanel } from './OperationalDlqPanel';
import { QueuesPage } from './QueuesPage';

const incident = {
  target: 'outbox',
  id: '8b31b078-dd9f-4da2-8d1e-f4050965db83',
  tenantId: 'Steven',
  kind: 'origin_relay',
  adapter: 'telegram',
  disposition: 'ambiguous',
  open: true,
  actionable: true,
  evidenceSha256: 'a'.repeat(64),
  attempts: 3,
  resolutionRule: 'telegram_effect_ambiguous_v1',
  createdAt: '2026-08-26T10:00:00.000Z',
  dispositionAt: '2026-08-26T10:01:00.000Z',
  resolvedAt: null,
  reopenCount: 0,
  lastReopenedAt: null,
};

function resolutionReceipt(possibleDuplicateAcknowledged: boolean) {
  return {
    schemaVersion: 1,
    suite: 'cauce-v3-dlq-no-replay-resolution',
    phase: 'resolved',
    appliedCount: 1,
    alreadyApplied: false,
    evidenceSha256: incident.evidenceSha256,
    reasonSha256: 'b'.repeat(64),
    possibleDuplicateAcknowledged,
    possibleNoDeliveryAcknowledged: true,
  };
}

it('renders only the safe DLQ projection and never leaks extra payload/error/provider fields', async () => {
  server.use(http.get('*/v3/console/dlq', () => HttpResponse.json({
    schemaVersion: 1, total: 1, truncated: false,
    items: [{
      ...incident,
      payload: { text: 'SENSITIVE_BODY' },
      reason: 'SENSITIVE_REASON',
      last_error: 'SENSITIVE_ERROR',
      provider_message_id: 'SENSITIVE_PROVIDER_ID',
    }],
  })));
  renderWithApi(<OperationalDlqPanel />);

  const table = await screen.findByRole('table', { name: /incidentes de dlq/i });
  expect(within(table).getByText('Steven')).toBeInTheDocument();
  expect(within(table).getByText('EFECTO INCIERTO')).toBeInTheDocument();
  expect(screen.queryByText(/SENSITIVE_/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('SENSITIVE_BODY');
  expect(document.body.textContent).not.toContain('SENSITIVE_REASON');
  expect(document.body.textContent).not.toContain('SENSITIVE_ERROR');
  expect(document.body.textContent).not.toContain('SENSITIVE_PROVIDER_ID');
});

it('walks the opaque keyset cursor and appends older incidents without duplicating the first page', async () => {
  const cursors: (string | null)[] = [];
  const older = {
    ...incident,
    id: '8b31b078-dd9f-4da2-8d1e-f4050965db84',
    tenantId: 'Miguel',
    kind: 'wake',
    disposition: 'auth',
  };
  server.use(http.get('*/v3/console/dlq', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    cursors.push(cursor);
    return cursor === null
      ? HttpResponse.json({
        schemaVersion: 1, total: 2, truncated: true, nextCursor: 'ab12', items: [incident],
      })
      : HttpResponse.json({
        schemaVersion: 1, total: 2, truncated: false, nextCursor: null, items: [older],
      });
  }));
  const user = userEvent.setup();
  renderWithApi(<OperationalDlqPanel />);

  expect(await screen.findByText('Steven')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /cargar más/i }));

  expect(await screen.findByText('Miguel')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cargar más/i })).not.toBeInTheDocument();
  expect(cursors).toEqual([null, 'ab12']);
  expect(within(screen.getByRole('table', { name: /incidentes de dlq/i })).getAllByRole('row')).toHaveLength(3);
});

it('installs the first-page cursor in the same committed frame as its rows', async () => {
  server.use(http.get('*/v3/console/dlq', () => HttpResponse.json({
    schemaVersion: 1,
    total: 2,
    truncated: true,
    nextCursor: 'ab12',
    items: [incident],
  })));
  const committedFrames: string[] = [];

  renderWithApi(
    <Profiler id="dlq-first-page" onRender={() => committedFrames.push(document.body.textContent)}>
      <OperationalDlqPanel />
    </Profiler>,
  );

  expect(await screen.findByText('Steven')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /cargar más/i })).toBeInTheDocument();
  const firstFrameWithRows = committedFrames.find((frame) => frame.includes('Steven'));
  expect(firstFrameWithRows).toContain('Cargar más');
});

it('stops a repeated cursor instead of polling the same page forever', async () => {
  server.use(http.get('*/v3/console/dlq', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    return HttpResponse.json({
      schemaVersion: 1,
      total: 2,
      truncated: true,
      nextCursor: 'ab12',
      items: cursor === null ? [incident] : [],
    });
  }));
  const user = userEvent.setup();
  renderWithApi(<OperationalDlqPanel />);

  await user.click(await screen.findByRole('button', { name: /cargar más/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/repitió el mismo cursor/i);
  expect(screen.queryByRole('button', { name: /cargar más/i })).not.toBeInTheDocument();
});

it('aborts and fences an old loadMore when a fresh first page starts', async () => {
  const stale = {
    ...incident,
    id: '8b31b078-dd9f-4da2-8d1e-f4050965db85',
    tenantId: 'STALE-TENANT',
  };
  const fresh = {
    ...incident,
    id: '8b31b078-dd9f-4da2-8d1e-f4050965db86',
    tenantId: 'Pablo',
  };
  let firstPageReads = 0;
  let loadMoreStarted = false;
  let loadMoreAborted = false;
  server.use(http.get('*/v3/console/dlq', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor === null) {
      firstPageReads += 1;
      return firstPageReads === 1
        ? HttpResponse.json({
          schemaVersion: 1, total: 2, truncated: true, nextCursor: 'ab12', items: [incident],
        })
        : HttpResponse.json({
          schemaVersion: 1, total: 1, truncated: false, nextCursor: null, items: [fresh],
        });
    }
    loadMoreStarted = true;
    return new Promise<Response>((resolve) => {
      request.signal.addEventListener('abort', () => {
        loadMoreAborted = true;
        // Incluso un transporte roto que entregue bytes despues del abort queda cercado por la
        // generacion; esta respuesta vieja nunca puede anexarse a la pagina fresca.
        resolve(HttpResponse.json({
          schemaVersion: 1, total: 2, truncated: false, nextCursor: null, items: [stale],
        }));
      }, { once: true });
    });
  }));
  const user = userEvent.setup();
  renderWithApi(<OperationalDlqPanel />);

  await user.click(await screen.findByRole('button', { name: /cargar más/i }));
  await waitFor(() => { expect(loadMoreStarted).toBe(true); });
  await user.click(screen.getByRole('button', { name: /^actualizar$/i }));

  expect(await screen.findByText('Pablo')).toBeInTheDocument();
  await waitFor(() => { expect(loadMoreAborted).toBe(true); });
  expect(screen.queryByText('STALE-TENANT')).not.toBeInTheDocument();
  expect(firstPageReads).toBe(2);
});

it('admits only one loadMore when two clicks arrive in the same render tick', async () => {
  let loadMoreCalls = 0;
  let finishLoadMore!: (response: Response) => void;
  server.use(http.get('*/v3/console/dlq', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor === null) {
      return HttpResponse.json({
        schemaVersion: 1, total: 2, truncated: true, nextCursor: 'ab12', items: [incident],
      });
    }
    loadMoreCalls += 1;
    return new Promise<Response>((resolve) => { finishLoadMore = resolve; });
  }));
  renderWithApi(<OperationalDlqPanel />);

  const loadMore = await screen.findByRole('button', { name: /cargar más/i });
  act(() => {
    loadMore.click();
    loadMore.click();
  });
  await waitFor(() => { expect(loadMoreCalls).toBe(1); });
  expect(loadMore).toBeDisabled();

  finishLoadMore(HttpResponse.json({
    schemaVersion: 1, total: 2, truncated: false, nextCursor: null, items: [],
  }));
  await waitFor(() => { expect(screen.queryByRole('button', { name: /cargar más/i })).not.toBeInTheDocument(); });
  expect(loadMoreCalls).toBe(1);
});

it('aborts an in-flight loadMore on unmount and ignores its late response', async () => {
  let loadMoreStarted = false;
  let loadMoreAborted = false;
  server.use(http.get('*/v3/console/dlq', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor === null) {
      return HttpResponse.json({
        schemaVersion: 1, total: 2, truncated: true, nextCursor: 'ab12', items: [incident],
      });
    }
    loadMoreStarted = true;
    return new Promise<Response>((resolve) => {
      request.signal.addEventListener('abort', () => {
        loadMoreAborted = true;
        resolve(HttpResponse.json({
          schemaVersion: 1,
          total: 2,
          truncated: false,
          nextCursor: null,
          items: [{ ...incident, tenantId: 'LATE-AFTER-UNMOUNT' }],
        }));
      }, { once: true });
    });
  }));
  const view = renderWithApi(<OperationalDlqPanel />);
  await screen.findByText('Steven');
  await userEvent.click(screen.getByRole('button', { name: /cargar más/i }));
  await waitFor(() => { expect(loadMoreStarted).toBe(true); });

  view.unmount();
  await waitFor(() => { expect(loadMoreAborted).toBe(true); });
  expect(screen.queryByText('LATE-AFTER-UNMOUNT')).not.toBeInTheDocument();
});

it('requires reason plus both uncertainty acknowledgements and sends an exact no-replay CAS', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestedPath = '';
  let externalReplayCalls = 0;
  server.use(
    http.get('*/v3/console/dlq', () => HttpResponse.json({ schemaVersion: 1, total: 1, truncated: false, items: [incident] })),
    http.post('*/v3/console/dlq/:target/:id/resolve-without-replay', async ({ request }) => {
      requestedPath = new URL(request.url).pathname;
      requestBody = await request.json() as Record<string, unknown>;
      return HttpResponse.json(resolutionReceipt(true));
    }),
    http.post('*/v3/console/deliveries/:id/replay', () => {
      externalReplayCalls += 1;
      return HttpResponse.json({ replayed: true });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<OperationalDlqPanel />);

  await user.click(await screen.findByRole('button', { name: /cerrar sin replay/i }));
  const dialog = screen.getByRole('alertdialog');
  const submit = within(dialog).getByRole('button', { name: /cerrar sin replay/i });
  expect(submit).toBeDisabled();
  await user.type(within(dialog).getByRole('textbox', { name: /motivo operativo/i }), 'Validación causal del operador');
  expect(submit).toBeDisabled();
  const checks = within(dialog).getAllByRole('checkbox');
  await user.click(checks[0]);
  expect(submit).toBeDisabled();
  await user.click(checks[1]);
  expect(submit).toBeEnabled();
  await user.click(submit);

  expect(await screen.findByText(/cerrado sin replay/i)).toBeInTheDocument();
  expect(requestedPath).toBe(`/v3/console/dlq/outbox/${incident.id}/resolve-without-replay`);
  expect(requestBody).toEqual({
    evidence_sha256: incident.evidenceSha256,
    reason: 'Validación causal del operador',
    possible_duplicate_acknowledged: true,
    possible_no_delivery_acknowledged: true,
  });
  expect(externalReplayCalls).toBe(0);
});

it.each(['safe_retry', 'auth'] as const)(
  '%s requires the no-delivery acknowledgement but never invents duplicate risk',
  async (incidentDisposition) => {
    let requestBody: Record<string, unknown> | undefined;
    server.use(
      http.get('*/v3/console/dlq', () => HttpResponse.json({
        schemaVersion: 1, total: 1, truncated: false,
        items: [{ ...incident, disposition: incidentDisposition }],
      })),
      http.post('*/v3/console/dlq/:target/:id/resolve-without-replay', async ({ request }) => {
        requestBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(resolutionReceipt(false));
      }),
    );
    const user = userEvent.setup();
    renderWithApi(<OperationalDlqPanel />);

    await user.click(await screen.findByRole('button', { name: /cerrar sin replay/i }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    await user.type(within(dialog).getByRole('textbox', { name: /motivo operativo/i }), 'Cierre causal comprobado');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: /cerrar sin replay/i }));

    expect(await screen.findByText(/cerrado sin replay/i)).toBeInTheDocument();
    expect(requestBody).toMatchObject({
      possible_duplicate_acknowledged: false,
      possible_no_delivery_acknowledged: true,
    });
  },
);

it('does not offer a mutation for open unclassified evidence even if a stale server says actionable', async () => {
  server.use(http.get('*/v3/console/dlq', () => HttpResponse.json({
    schemaVersion: 1, total: 1, truncated: false,
    items: [{ ...incident, disposition: 'unclassified', actionable: true }],
  })));
  renderWithApi(<OperationalDlqPanel />);

  expect(within(await screen.findByRole('table', { name: /incidentes de dlq/i })).getByText('SIN CLASIFICAR')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cerrar sin replay/i })).not.toBeInTheDocument();
  expect(screen.getByText('Requiere evidencia causal')).toBeInTheDocument();
});

it('does not claim success when a 2xx response lacks the exact durable receipt', async () => {
  server.use(
    http.get('*/v3/console/dlq', () => HttpResponse.json({
      schemaVersion: 1, total: 1, truncated: false, items: [incident],
    })),
    http.post('*/v3/console/dlq/:target/:id/resolve-without-replay', () => HttpResponse.json({
      ...resolutionReceipt(true),
      appliedCount: 0,
      alreadyApplied: false,
      evidenceSha256: 'c'.repeat(64),
    })),
  );
  const user = userEvent.setup();
  renderWithApi(<OperationalDlqPanel />);

  await user.click(await screen.findByRole('button', { name: /cerrar sin replay/i }));
  const dialog = screen.getByRole('alertdialog');
  await user.type(within(dialog).getByRole('textbox', { name: /motivo operativo/i }), 'Cierre causal comprobado');
  for (const checkbox of within(dialog).getAllByRole('checkbox')) await user.click(checkbox);
  await user.click(within(dialog).getByRole('button', { name: /cerrar sin replay/i }));

  expect(await screen.findByRole('status')).toHaveTextContent(/no devolvió un recibo durable exacto/i);
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(screen.queryByText(/cerrado sin replay; Cauce no reinyectó/i)).not.toBeInTheDocument();
});

it('fails closed without crashing when the server returns a prototype-key disposition', async () => {
  server.use(http.get('*/v3/console/dlq', () => HttpResponse.json({
    schemaVersion: 1, total: 1, truncated: false,
    items: [{ ...incident, disposition: 'toString', actionable: true }],
  })));
  renderWithApi(<OperationalDlqPanel />);

  const table = await screen.findByRole('table', { name: /incidentes de dlq/i });
  expect(within(table).getAllByText('sin dato').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: /cerrar sin replay/i })).not.toBeInTheDocument();
  expect(screen.getByText('Requiere evidencia causal')).toBeInTheDocument();
});

it('does not even request the operator-only DLQ endpoint when RBAC denies dlq.resolve', async () => {
  let dlqReads = 0;
  server.use(
    http.get('*/v3/console/access', () => HttpResponse.json({
      subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
    })),
    http.get('*/v3/console/queues', () => HttpResponse.json({ items: [], pending: 0, retrying: 0, dead: 0 })),
    http.get('*/v3/console/dlq', () => {
      dlqReads += 1;
      return HttpResponse.json({ items: [] });
    }),
  );
  renderWithApi(<QueuesPage />);

  expect(await screen.findByText(/no tiene control operativo/i)).toBeInTheDocument();
  expect(dlqReads).toBe(0);
});
