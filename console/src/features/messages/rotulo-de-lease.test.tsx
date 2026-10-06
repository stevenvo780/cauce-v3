import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { LEASE_LABEL } from '../../vocabulario';
import { LIVE_STATE_META } from '../live/agent-state';
import { AgentList } from '../../shell/AgentList';
import { FleetProvider } from '../../shell/fleet';
import { renderWithApi } from '../../test/render';
import { MessagesPage } from './MessagesPage';
import { openConversationInfo } from './chat-test-utils';

/** Header and sidebar read the same live state; the lease stays as secondary detail. */

afterEach(() => { window.history.pushState({}, '', '/'); });

it('la cabecera del hilo y la barra lateral nombran el mismo estado vivo', async () => {
  const user = userEvent.setup();
  window.history.pushState({}, '', '/messages/Miguel/kratos');
  renderWithApi(<FleetProvider><AgentList routeId="messages" /><MessagesPage params={['Miguel', 'kratos']} /></FleetProvider>);

  const hilo = await screen.findByRole('region', { name: 'Conversación con kratos' });
  const etiquetas = Object.values(LIVE_STATE_META).map((meta) => meta.label);
  const fila = await screen.findByRole('link', { name: /kratos/ });
  await waitFor(() => {
    const pill = hilo.querySelector('header [data-live-state]');
    const estado = pill?.textContent ?? '';
    expect(etiquetas).toContain(estado);
    expect(fila).toHaveTextContent(estado);
  });

  const detalles = await openConversationInfo(user);
  const leaseWords = Object.values(LEASE_LABEL);
  const lease = within(detalles).getByText(/^Lease /);
  expect(leaseWords.some((word) => lease.textContent.startsWith(`Lease ${word}`))).toBe(true);
}, 25_000);
