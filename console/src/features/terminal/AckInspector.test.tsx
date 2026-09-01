import { render, screen } from '@testing-library/react';
import { AckInspector } from './AckInspector';

const DELIVERY_ID = 'a0000000-0000-4000-8000-000000000001';

it('muestra el timeline en solo lectura y enlaza la delivery exacta a Queues', () => {
  render(<AckInspector delivery={{
    delivery_id: DELIVERY_ID, status: 'dead', attempt: 5,
    timeline: [{ status: 'published', at: '2026-07-23T00:00:00Z', attempt: 1 }],
  }} />);

  expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
  const queues = screen.getByRole('link', { name: /gestionar en queues/i });
  expect(queues).toHaveAttribute('href', `/queues?delivery=${DELIVERY_ID}`);
  expect(queues).toHaveAttribute('target', '_blank');
  expect(screen.queryByRole('button', { name: /replay/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cancelar/i })).not.toBeInTheDocument();
});

it('un id fuera del contrato se muestra pero no se convierte en enlace operativo', () => {
  render(<AckInspector delivery={{ delivery_id: 'delivery/dead 1', status: 'dead' }} />);

  expect(screen.getByText('delivery/dead 1')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /queues/i })).not.toBeInTheDocument();
  expect(screen.getByText(/ID navegable/i)).toBeInTheDocument();
});

it('sin delivery no inventa un enlace operativo', () => {
  render(<AckInspector />);

  expect(screen.getByText(/seleccioná una delivery/i)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /queues/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
