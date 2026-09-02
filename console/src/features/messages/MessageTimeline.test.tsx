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
