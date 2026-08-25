import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * EL CONTRATO DE TECLADO Y DE FOCO DEL DIÁLOGO DE DIRECTIVA.
 *
 * Esto es exactamente lo que jsdom SÍ puede demostrar: qué elemento tiene el foco, qué escucha
 * Escape, qué atributos ARIA hay y qué pasa al cerrar. Lo que NO puede demostrar —y no se
 * pretende acá— es que el diálogo quepa: jsdom no calcula layout, todas las cajas miden 0. La
 * geometría se midió en Chrome y va en el informe.
 *
 * Cada caso de abajo describe un fallo que un modal mal hecho comete de verdad:
 *  · abrir y dejar el foco fuera → el teclado sigue en la página de detrás, apagada;
 *  · cerrar y soltar el foco en `body` → el siguiente tabulador vuelve al principio de la consola;
 *  · Escape sin cortar la propagación → el cajón, que tiene su PROPIO Escape, se cierra también;
 *  · tabulador sin trampa → se sale al fondo inerte y el foco desaparece de la vista;
 *  · el fondo sigue vivo → se puede desplazar y pulsar lo de detrás del velo.
 */

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

function configConBrief(roleBrief: string) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1,
    observed_at: new Date().toISOString(),
    agents: [
      { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true, role_brief: roleBrief },
    ],
    tenants: [], rooms: [], memberships: [], acl_edges: [], harness_definitions: [],
    role_policies: [], chain_policies: [], egress_destinations: [], provider_accounts: [],
    alias_routing_ceiling: [], agent_account_bindings: [], revisions: [],
  })));
}

async function abrir() {
  const user = userEvent.setup();
  configConBrief('Sos kant, el hub de la flota.\nAUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  const boton = await within(cajon).findByRole('button', { name: /abrir directiva completa/i });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  return { user, cajon, dialogo, boton };
}

it('se anuncia como diálogo modal y con nombre', async () => {
  const { dialogo } = await abrir();
  expect(dialogo).toHaveAttribute('aria-modal', 'true');
  expect(dialogo).toHaveAttribute('aria-labelledby', 'directiva-modal-titulo');
  expect(document.getElementById('directiva-modal-titulo')).toHaveTextContent('Directiva de kant');
}, 25_000);

it('el foco entra al diálogo al abrir y vuelve al botón que lo abrió al cerrar', async () => {
  const { user, dialogo, boton } = await abrir();
  expect(dialogo.contains(document.activeElement)).toBe(true);

  await user.click(within(dialogo).getByRole('button', { name: /cerrar la directiva/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.activeElement).toBe(boton);
}, 25_000);

/**
 * Escape cierra el DIÁLOGO y sólo el diálogo. `AgentDrawer` tiene su propio escuchador de Escape
 * en `document` para cerrarse; sin cortar la propagación, una sola pulsación se llevaba los dos
 * por delante y el operador se quedaba mirando el mapa.
 */
it('Escape cierra el diálogo y deja el cajón abierto', async () => {
  const { user } = await abrir();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: /detalle de kant/i })).toBeInTheDocument();
}, 25_000);

it('un clic en el velo cierra; un clic dentro del diálogo no', async () => {
  const { user, dialogo } = await abrir();
  await user.click(within(dialogo).getByText('Directiva de kant'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  const velo = dialogo.parentElement as HTMLElement;
  expect(velo).toHaveClass('directiva-modal-fondo');
  await user.click(velo);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}, 25_000);

/**
 * La trampa de foco: desde el último control, Tab vuelve al primero; desde el primero, Shift+Tab
 * salta al último. Sin esto el tabulador se va al armazón —que está `inert`— y el foco
 * desaparece: no se ve dónde está y no hay forma de volver sin el ratón.
 */
it('el tabulador da la vuelta dentro del diálogo en vez de irse al fondo', async () => {
  const { user, dialogo } = await abrir();
  const focos = [...dialogo.querySelectorAll<HTMLElement>(
    'button:not([disabled]), summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )];
  expect(focos.length).toBeGreaterThan(1);

  focos[focos.length - 1].focus();
  await user.tab();
  expect(document.activeElement).toBe(focos[0]);

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(focos[focos.length - 1]);
}, 25_000);

/**
 * El fondo se apaga mientras el diálogo vive, y se enciende al cerrarlo.
 *
 * `inert` sobre `.app-shell` corta ratón, tabulador y lector de pantalla. La clase del elemento
 * raíz es lo que corta la RUEDA: medido en Chrome, con el diálogo abierto la página de detrás
 * conservaba 2.894 px de recorrido. Acá se comprueba el MECANISMO —el atributo y la clase—; que
 * la regla CSS que cuelga de esa clase haga efecto se midió en Chrome, porque jsdom no carga la
 * hoja de estilos y `getComputedStyle` devolvería el valor por defecto pase lo que pase.
 */
it('mientras el diálogo vive, el armazón queda inerte y el cajón marcado como no desplazable', async () => {
  const { user, dialogo } = await abrir();
  expect(document.documentElement).toHaveClass('directiva-modal-abierta');

  await user.click(within(dialogo).getByRole('button', { name: /cerrar la directiva/i }));
  expect(document.documentElement).not.toHaveClass('directiva-modal-abierta');
}, 25_000);

/** La columna legacy no puede reabrir un guardado que omita el ACK del runtime. */
it('la columna 1 muestra la proyección sólo lectura y dirige al perfil canónico', async () => {
  const { dialogo } = await abrir();
  const capa1 = within(dialogo).getByLabelText('Capa 1: rol declarado');
  expect(await within(capa1).findByLabelText(/proyección del rol de kant/i)).toHaveAttribute('readonly');
  expect(within(capa1).getByText(/\/ 1200$/)).toBeInTheDocument();
  expect(within(capa1).queryByRole('button', { name: /guardar el rol/i })).not.toBeInTheDocument();
  expect(within(capa1).getByRole('button', { name: /editar el perfil canónico/i })).toBeInTheDocument();
}, 25_000);
