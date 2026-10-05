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
    expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
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
  expect(receipt.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(receipt).toHaveAttribute('aria-label', 'Entrega: Publicado · esperando aceptación del agente');
});

it('conserva el recibo aplicado anterior cuando un intento posterior falla', () => {
  const timeline: TimelineEvent[] = [
    { status: 'published' }, { status: 'accepted', detail: null },
    { status: 'started', detail: 'duplicate_or_out_of_order' },
  ];
  render(<MessageDeliveryCheck delivery={{ status: 'failed', timeline }} />);
  const receipt = screen.getByRole('status', { name: 'Entrega: La ejecución falló' });
  expect(receipt.querySelector('[data-checks="2"]')).toBeInTheDocument();
  expect(receipt).toHaveClass('chat-delivery-check-danger');
});

it('un ACK rechazado aislado no inventa publicación ni recepción', () => {
  const delivery: DeliveryView = { timeline: [{ status: 'accepted', detail: 'duplicate_or_out_of_order' }] };
  render(<MessageDeliveryCheck delivery={delivery} />);
  expect(screen.getByRole('status').querySelector('[data-checks]')).toBeNull();
});
