import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { DeliveryView, TimelineEvent } from '../../api/types';
import { MessageDeliveryCheck } from './MessageDeliveryCheck';

it.each(['accepted', 'started', 'done'] as const)(
  'un ACK %s rechazado por el gateway no acredita recepción', (status) => {
    render(<MessageDeliveryCheck delivery={{ status: 'retry', timeline: [
      { status: 'published' },
      { status, detail: 'duplicate_or_out_of_order' },
    ] }} />);
    const receipt = screen.getByRole('status');
    expect(receipt.querySelector('[data-checks]')).toBeNull();
    expect(receipt.querySelector('[data-checks="2"]')).toBeNull();
    expect(receipt).toHaveAttribute('aria-label', 'Entrega: Cauce reintentará la entrega');
  },
);

it('un historial con ACK rechazado no completa el estado ausente', () => {
  render(<MessageDeliveryCheck delivery={{ timeline: [
    { status: 'published' },
    { status: 'done', detail: 'duplicate_or_out_of_order' },
  ] }} />);
  const receipt = screen.getByRole('status');
  expect(receipt.querySelector('[data-checks]')).toBeNull();
  expect(receipt).toHaveAttribute('aria-label', 'Entrega: Publicado · esperando aceptación del agente');
});

it('conserva el recibo aplicado anterior cuando un intento posterior falla', () => {
  const timeline: TimelineEvent[] = [
    { status: 'published' }, { status: 'accepted', detail: null },
    { status: 'started', detail: 'duplicate_or_out_of_order' },
  ];
  render(<MessageDeliveryCheck delivery={{ status: 'failed', timeline }} />);
  const receipt = screen.getByRole('status', { name: 'Entrega: La ejecución falló' });
  expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(receipt).toHaveAttribute('data-failed', 'true');
});

it('un ACK rechazado aislado no inventa publicación ni recepción', () => {
  const delivery: DeliveryView = { timeline: [{ status: 'accepted', detail: 'duplicate_or_out_of_order' }] };
  render(<MessageDeliveryCheck delivery={delivery} />);
  expect(screen.getByRole('status').querySelector('[data-checks]')).toBeNull();
});

const consumption = {
  version: 1, harness_id: 'codex', native_session_id: 'session-a', native_turn_id: 'turn-a',
  input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response',
} as const;

it.each(['accepted', 'started', 'done'] as const)('%s sin comprobante muestra recibido, sin afirmar leído', (status) => {
  render(<MessageDeliveryCheck delivery={{ status, attempt: 1, timeline: [{ status, applied: true, attempt: 1 }] }} />);
  const receipt = screen.getByRole('status');
  expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(receipt.querySelector('[data-checks="2"]')).toBeNull();
  expect(receipt).toHaveAttribute('title', expect.stringContaining('Lectura sin comprobar'));
});

it('solo un comprobante aplicado del intento vigente muestra doble check de lectura', () => {
  render(<MessageDeliveryCheck delivery={{ status: 'done', attempt: 2, timeline: [{
    status: 'done', applied: true, attempt: 2, harness_consumption: consumption,
  }] }} />);
  const receipt = screen.getByRole('status', { name: 'Entrega: Leído por el agente · respuesta nativa comprobada' });
  expect(receipt.querySelector('[data-checks="2"]')).toBeInTheDocument();
  expect(receipt).toHaveAttribute('title', expect.stringContaining('Lectura comprobada'));
});

it.each([
  { applied: false, attempt: 2 }, { applied: undefined, attempt: 2 },
  { applied: true, attempt: 1 }, { applied: true, attempt: undefined },
])('un comprobante rechazado, ambiguo o de otro intento no acredita lectura: %j', (binding) => {
  render(<MessageDeliveryCheck delivery={{ status: 'done', attempt: 2, timeline: [{
    status: 'done', ...binding, harness_consumption: consumption,
  }] }} />);
  expect(screen.getByRole('status').querySelector('[data-checks="2"]')).toBeNull();
});

it('un intento ausente no convierte evidencia sin binding en lectura', () => {
  render(<MessageDeliveryCheck delivery={{ status: 'done', timeline: [{
    status: 'done', applied: true, harness_consumption: consumption,
  }] }} />);
  expect(screen.getByRole('status').querySelector('[data-checks="2"]')).toBeNull();
});

it('rechaza la evidencia malformada aunque el ACK esté aplicado', () => {
  render(<MessageDeliveryCheck delivery={{ status: 'done', attempt: 1, timeline: [{
    status: 'done', applied: true, attempt: 1,
    harness_consumption: { ...consumption, input_sha256: 'not-a-digest' },
  }] }} />);
  expect(screen.getByRole('status').querySelector('[data-checks="2"]')).toBeNull();
});

it('muestra «Guardado en buzón» con explicación sin afirmar lectura ni ejecución', () => {
  const delivery: DeliveryView = {
    delivery_id: '10000000-0000-4000-8000-000000000001',
    recipient_alias: 'mbx-0123456789abcdef0123456789abcdef',
    status: 'done',
    attempt: 0,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 0 }],
    client_mailbox: { label: 'Buzón Cronos', state: 'stored' },
  };
  render(<MessageDeliveryCheck delivery={delivery} />);
  const receipt = screen.getByRole('status', { name: 'Entrega: Guardado en buzón' });
  expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(receipt.querySelector('[data-checks="2"]')).toBeNull();
  expect(receipt).toHaveAttribute('title', 'Buzón Cronos: Guardado en buzón. No acredita lectura ni ejecución.');
  expect(receipt.getAttribute('aria-label')).not.toMatch(/ejecutad|ejecución terminada/i);
  expect(receipt.getAttribute('title')).not.toMatch(/ejecutad|ejecución terminada/i);
  expect(screen.queryByText(/ejecutad|ejecución terminada/i)).toBeNull();
});

it('no infiere buzón por prefijo mbx- sin el marcador client_mailbox del API', () => {
  const delivery: DeliveryView = {
    delivery_id: '10000000-0000-4000-8000-000000000002',
    recipient_alias: 'mbx-0123456789abcdef0123456789abcdef',
    status: 'done',
    attempt: 1,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 1 }],
  };
  render(<MessageDeliveryCheck delivery={delivery} />);
  const receipt = screen.getByRole('status');
  expect(receipt).toHaveAttribute('aria-label', 'Entrega: Recibido por el agente · ejecución terminada');
  expect(receipt.getAttribute('aria-label')).not.toContain('Guardado en buzón');
});

it('el marcador de buzón nunca acredita lectura aunque llegue evidencia de consumo', () => {
  render(<MessageDeliveryCheck delivery={{
    status: 'done', attempt: 1,
    client_mailbox: { label: 'Buzón Cronos', state: 'stored' },
    timeline: [{ status: 'done', applied: true, attempt: 1, harness_consumption: consumption }],
  }} />);
  const receipt = screen.getByRole('status', { name: 'Entrega: Guardado en buzón' });
  expect(receipt.querySelector('[data-checks="2"]')).toBeNull();
  expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
});
