import { render, screen, within } from '@testing-library/react';
import { MessageTimeline } from './MessageTimeline';

it('renders the publish to terminal ACK sequence', () => {
  render(<MessageTimeline events={[
    { status: 'published', at: '2026-07-22T10:00:00Z' },
    { status: 'accepted', at: '2026-07-22T10:00:01Z' },
    { status: 'started', at: '2026-07-22T10:00:02Z' },
    { status: 'done', at: '2026-07-22T10:00:03Z' },
  ]} />);
  const timeline = screen.getByRole('list', { name: /timeline/i });
  expect(within(timeline).getByText('PUBLICADA')).toHaveClass('badge-info');
  expect(within(timeline).getByText('ACEPTADA')).toHaveClass('badge-running');
  expect(within(timeline).getByText('EN CURSO')).toHaveClass('badge-running');
  expect(within(timeline).getByText('HECHA')).toHaveClass('badge-done');
});

it('uses the same danger policy as queues for a failed terminal ACK', () => {
  render(<MessageTimeline events={[
    { status: 'published' },
    { status: 'accepted' },
    { status: 'started' },
    { status: 'failed', detail: 'adapter timeout' },
  ]} />);
  expect(screen.getByText('FALLÓ')).toHaveClass('badge-danger');
});

it('muestra «Guardado en buzón» y explicación en la timeline sin afirmar ejecución ni mostrar HECHA', () => {
  render(<MessageTimeline
    events={[
      { status: 'published', at: '2026-07-22T10:00:00Z' },
      { status: 'done', at: '2026-07-22T10:00:01Z', attempt: 0 },
    ]}
    clientMailbox={{ label: 'Buzón Cronos', state: 'stored' }}
  />);
  const timeline = screen.getByRole('list', { name: /timeline/i });
  expect(within(timeline).getByText('PUBLICADA')).toHaveClass('badge-info');
  expect(within(timeline).getByText('Guardado en buzón')).toHaveClass('badge-done');
  expect(within(timeline).getByText(/no acredita lectura ni ejecución/i)).toBeInTheDocument();
  expect(within(timeline).queryByText('HECHA')).toBeNull();
  expect(within(timeline).queryByText(/ejecutad/i)).toBeNull();
  expect(within(timeline).queryByText('ACEPTADA')).toBeNull();
  expect(within(timeline).queryByText('EN CURSO')).toBeNull();
});

it('rechaza un marcador almacenado sin etiqueta válida', () => {
  render(<MessageTimeline events={[{ status: 'done' }]} clientMailbox={{ label: ' ', state: 'stored' }} />);
  expect(screen.getByText('HECHA')).toBeInTheDocument();
  expect(screen.queryByText('Guardado en buzón')).toBeNull();
});
