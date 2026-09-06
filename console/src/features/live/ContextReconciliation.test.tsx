import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ContextReconciliation } from './ContextReconciliation';
import { isReconciliationPreview, isReconciliationReceipt, reconciliationApply } from './context-reconciliation';

const BASE = 'http://localhost/v3/console/tenants/Steven/agents/socrates/context/reconcile';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const EXTERIOR = 'c'.repeat(64);
const REASON = 'Restaurar el bloque sin cambiar el exterior revisado';
const PATH = '/home/dev/.codex/AGENTS.md';
const PREVIEW = {
  ok: true as const, tenant_id: 'Steven', alias: 'socrates', expected_revision: 4,
  expected_runtime_generation: 'generation-4', preserve_external: true as const,
  documents: [{ name: 'AGENTS.md', observed_sha: OLD, exterior_sha: EXTERIOR }],
};
const RECEIPT = {
  ok: true, tenant_id: 'Steven', alias: 'socrates', revision: 4,
  state: 'pending_session_refresh', evidence: 'runtime_verification', message: 'bytes verificados',
  preserve_external: true,
  documents: [{ name: 'AGENTS.md', path: PATH, sha_before: OLD, sha_after: NEW, bytes: 321 }],
  contaminacion: { contaminated: false, findings: [] },
  runtime_verification: {
    state: 'current', generation: 'generation-4', container_id: 'runtime', observed_at: 'now',
    documents: [{ name: 'AGENTS.md', path: PATH, expected_sha: NEW, observed_sha: NEW,
      expected_bytes: 321, observed_bytes: 321, current: true }],
  },
};

function props() {
  return {
    tenantId: 'Steven', alias: 'socrates', revision: 4, documents: ['AGENTS.md'],
    permitida: true, bloqueada: false, onVeredicto: vi.fn(), onSettled: vi.fn(),
    onWriteInFlightChange: vi.fn(),
  };
}

async function measure(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Motivo de la reconciliación'), REASON);
  await user.click(screen.getByRole('button', { name: 'Medir antes de reconciliar' }));
}

function previewHandler() {
  server.use(http.post(`${BASE}/preview`, () => HttpResponse.json(PREVIEW)));
}

it('requires a reason, a fresh preview and an explicit confirmation before writing', async () => {
  const previewBodies: unknown[] = [];
  const applyBodies: unknown[] = [];
  server.use(
    http.post(`${BASE}/preview`, async ({ request }) => {
      previewBodies.push(await request.json()); return HttpResponse.json(PREVIEW);
    }),
    http.post(`${BASE}/apply`, async ({ request }) => {
      applyBodies.push(await request.json()); return HttpResponse.json(RECEIPT);
    }),
  );
  const callbacks = props();
  const user = userEvent.setup();
  renderWithApi(<ContextReconciliation {...callbacks} />);
  expect(screen.getByRole('button', { name: 'Medir antes de reconciliar' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Reconciliar el bloque gestionado' })).toBeNull();
  await measure(user);
  const apply = await screen.findByRole('button', { name: 'Reconciliar el bloque gestionado' });
  expect(apply).toBeDisabled();
  expect(previewBodies).toEqual([{ reason: REASON }]);
  expect(applyBodies).toHaveLength(0);
  expect(screen.getByText(EXTERIOR)).toBeInTheDocument();
  expect(screen.getByText(/no muestra ni acredita una revisión del contenido exterior/)).toBeInTheDocument();
  expect(screen.queryByText(/Revisé el contenido exterior/)).toBeNull();
  await user.click(screen.getByRole('checkbox'));
  await user.click(apply);
  await screen.findByText(/Escritura y huellas verificadas/);
  expect(applyBodies).toEqual([reconciliationApply(PREVIEW, REASON)]);
  expect(callbacks.onVeredicto).toHaveBeenCalledWith({ contaminated: false, findings: [] });
  expect(callbacks.onSettled).toHaveBeenCalledOnce();
  expect(callbacks.onWriteInFlightChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  expect(screen.getByRole('status')).toHaveTextContent('Falta el ACK de adopción');
});

it.each([{ permitida: false }, { bloqueada: true }])('sends nothing without permission or while another write is pending: %j', (blocked) => {
  renderWithApi(<ContextReconciliation {...props()} {...blocked} />);
  expect(screen.getByLabelText('Motivo de la reconciliación')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Medir antes de reconciliar' })).toBeDisabled();
});

it('invalidates the preview when the reason changes', async () => {
  previewHandler();
  const user = userEvent.setup();
  renderWithApi(<ContextReconciliation {...props()} />);
  await measure(user);
  await screen.findByRole('checkbox');
  await user.type(screen.getByLabelText('Motivo de la reconciliación'), ' actualizado');
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('discards a delayed preview after the target changes', async () => {
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  server.use(http.post(`${BASE}/preview`, async () => {
    requested = true; await barrier; return HttpResponse.json(PREVIEW);
  }));
  const original = props();
  const user = userEvent.setup();
  const view = renderWithApi(<ContextReconciliation {...original} />);
  await measure(user);
  await waitFor(() => { expect(requested).toBe(true); });
  view.rerender(<ContextReconciliation {...original} alias="kant" />);
  await act(async () => { release?.(); });
  await waitFor(() => { expect(original.onWriteInFlightChange).toHaveBeenLastCalledWith(false); });
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(original.onVeredicto).not.toHaveBeenCalled();
});

it('revoking permission invalidates a preview and restoring it does not resurrect confirmation', async () => {
  previewHandler();
  const user = userEvent.setup();
  const original = props();
  const view = renderWithApi(<ContextReconciliation {...original} />);
  await measure(user);
  await user.click(await screen.findByRole('checkbox'));
  view.rerender(<ContextReconciliation {...original} permitida={false} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  view.rerender(<ContextReconciliation {...original} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('a conflict clears confirmation, preserves the reason and does not claim no writes occurred', async () => {
  previewHandler();
  server.use(http.post(`${BASE}/apply`, () => HttpResponse.json({
    error: 'reconcile_snapshot_conflict', message: 'La revisión cambió durante la operación.',
  }, { status: 409 })));
  const callbacks = props();
  const user = userEvent.setup();
  renderWithApi(<ContextReconciliation {...callbacks} />);
  await measure(user);
  await user.click(await screen.findByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Reconciliar el bloque gestionado' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('puede haber efectos parciales');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByLabelText('Motivo de la reconciliación')).toHaveValue(REASON);
  expect(callbacks.onVeredicto).not.toHaveBeenCalled();
  expect(callbacks.onSettled).toHaveBeenCalledOnce();
});

it('rejects malformed success without reporting adopted or rewritten context', async () => {
  previewHandler();
  server.use(http.post(`${BASE}/apply`, () => HttpResponse.json({ ...RECEIPT, state: 'applied' })));
  const callbacks = props();
  const user = userEvent.setup();
  renderWithApi(<ContextReconciliation {...callbacks} />);
  await measure(user);
  await user.click(await screen.findByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Reconciliar el bloque gestionado' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no acredita el lote completo');
  expect(callbacks.onVeredicto).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([
  { alias: 'kant' }, { tenant_id: 'Miguel' }, { expected_revision: 5 },
  { expected_runtime_generation: '' }, { preserve_external: false }, { documents: [] },
  { documents: [PREVIEW.documents[0], PREVIEW.documents[0]] },
  { documents: [{ ...PREVIEW.documents[0], observed_sha: 'invalid' }] },
  { documents: [{ ...PREVIEW.documents[0], exterior_sha: 'invalid' }] },
  { documents: [{ ...PREVIEW.documents[0], name: 'CLAUDE.md' }] },
])('rejects a preview with a different or incomplete contract %j', (change) => {
  expect(isReconciliationPreview({ ...PREVIEW, ...change }, props())).toBe(false);
});

it.each([
  { alias: 'kant' }, { revision: 5 }, { preserve_external: false },
  { state: 'applied' }, { evidence: 'adapter_delivery' }, { documents: [] },
  { documents: [{ ...RECEIPT.documents[0], sha_before: EXTERIOR }] },
  { documents: [{ ...RECEIPT.documents[0], path: '/home/../AGENTS.md' }] },
  { contaminacion: { contaminated: true, findings: [] } },
  { runtime_verification: { ...RECEIPT.runtime_verification, generation: 'other' } },
  { runtime_verification: { ...RECEIPT.runtime_verification, documents: [] } },
  { runtime_verification: { ...RECEIPT.runtime_verification, documents: [null] } },
  { runtime_verification: { ...RECEIPT.runtime_verification,
    documents: [{ ...RECEIPT.runtime_verification.documents[0], observed_sha: OLD }] } },
])('rejects a receipt lacking exact measured evidence %j', (change) => {
  expect(isReconciliationReceipt({ ...RECEIPT, ...change }, PREVIEW)).toBe(false);
});

it('recognizes the complete preview and receipt contracts', () => {
  expect(isReconciliationPreview(PREVIEW, props())).toBe(true);
  expect(isReconciliationReceipt(RECEIPT, PREVIEW)).toBe(true);
});
