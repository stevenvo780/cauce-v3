import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueuesPage } from './QueuesPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

it('requests replay from the API and reports the accepted action', async () => {
  let replayed = '';
  server.use(
    http.get('http://localhost/v3/console/queues', () => HttpResponse.json({ dead: 1, items: [{ delivery_id: 'delivery-dead-1', state: 'dead', attempts: 5, max_attempts: 5 }] })),
    http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
      replayed = String(params.deliveryId);
      return HttpResponse.json({ delivery_id: replayed, state: 'pending', replayed: true }, { status: 202 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<QueuesPage />);
  await user.click(await screen.findByRole('button', { name: /replay delivery delivery-dead-1/i }));

  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe('delivery-dead-1');
});
