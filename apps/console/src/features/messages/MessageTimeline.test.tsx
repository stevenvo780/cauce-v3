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
  expect(within(timeline).getByText('PUBLISHED')).toBeInTheDocument();
  expect(within(timeline).getByText('ACCEPTED')).toBeInTheDocument();
  expect(within(timeline).getByText('STARTED')).toBeInTheDocument();
  expect(within(timeline).getByText('DONE')).toBeInTheDocument();
});
