import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from './Tooltip';

it('abre con el ratón tras el retraso y expone role="tooltip"', async () => {
  const user = userEvent.setup();
  render(<Tooltip label="en vuelo = leased + accepted + started"><span>En vuelo</span></Tooltip>);

  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  await user.hover(screen.getByText('En vuelo'));

  const globo = await screen.findByRole('tooltip');
  expect(globo).toHaveTextContent('leased + accepted + started');
});

it('abre CON EL FOCO DE TECLADO, no sólo con el ratón', async () => {
  // El teclado navega con Tab; el tooltip debe responder al foco además de al hover.
  const user = userEvent.setup();
  render(<Tooltip label="ack_deadline_at ya pasó"><span>Vencidas</span></Tooltip>);

  await user.tab();
  expect(await screen.findByRole('tooltip')).toHaveTextContent('ack_deadline_at ya pasó');
});

it('ata el globo al disparador con aria-describedby', async () => {
  const user = userEvent.setup();
  render(<Tooltip label="definición del servidor"><span>Cifra</span></Tooltip>);

  await user.tab();
  const globo = await screen.findByRole('tooltip');
  const disparador = screen.getByText('Cifra').closest('.tooltip-anchor');
  expect(disparador).toHaveAttribute('aria-describedby', globo.id);
  // UUID v4 emitido por crypto.randomUUID (vía createId('tooltip')).
  expect(globo.id).toMatch(/^tooltip-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('cierra con Esc sin tener que mover el ratón', async () => {
  const user = userEvent.setup();
  render(<Tooltip label="se cierra con Esc"><span>Ancla</span></Tooltip>);

  await user.tab();
  await screen.findByRole('tooltip');
  await user.keyboard('{Escape}');

  await waitFor(() => { expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(); });
});

it('no toma foco propio cuando envuelve un control que ya es enfocable', async () => {
  // Evita dos paradas de Tab para un solo control enfocable.
  const user = userEvent.setup();
  render(
    <Tooltip focusable={false} label="Conectado, con lease vigente y nada en vuelo.">
      <button type="button">Libre 14</button>
    </Tooltip>,
  );

  const ancla = screen.getByRole('button').closest('.tooltip-anchor');
  expect(ancla).not.toHaveAttribute('tabindex');

  await user.tab();
  expect(screen.getByRole('button')).toHaveFocus();
  expect(await screen.findByRole('tooltip')).toHaveTextContent('nada en vuelo');
});
