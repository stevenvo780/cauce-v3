import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * LAS TRES CAPAS, PROBADAS DESDE LA PÁGINA VIVA.
 *
 * Igual que el editor del rol: la mitad del encargo es DÓNDE vive. Un test del componente suelto
 * pasaría verde con la pestaña desenganchada del cajón, que es exactamente el defecto que hace que
 * nadie mantenga el `CLAUDE.md` —está, pero no hay por dónde llegar—.
 *
 * Los dos casos que importan son opuestos y los dos tienen que ser ciertos a la vez:
 *  · con el endpoint publicado, las tres capas se ven y el solapamiento se DICE;
 *  · sin el endpoint publicado, la pantalla declara que NO MIRÓ, y no puede afirmar ni que hay
 *    manual ni que no lo hay. Ese es el control negativo, y es el que esta consola ya falló antes
 *    en otras pantallas.
 */

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

/** El mismo registro que usa el editor del rol, para que el brief de kant sea el de siempre. */
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

async function abrirDirectivaDeKant() {
  const user = userEvent.setup();
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  return cajon;
}

it('la pestaña rotula las TRES capas por su fin, no sólo por su nombre técnico', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const cajon = await abrirDirectivaDeKant();

  // Los tres rótulos son las tres preguntas que deciden dónde va a parar cada frase.
  expect(await within(cajon).findByText('QUIÉN SOS y QUÉ PODÉS DECIDIR')).toBeInTheDocument();
  expect(within(cajon).getByText('CÓMO SE TRABAJA AQUÍ')).toBeInTheDocument();
  expect(within(cajon).getByText('LO QUE ESE AGENTE APRENDIÓ')).toBeInTheDocument();

  // Y la capa 1 sigue siendo el MISMO editor: la pestaña ensancha, no reemplaza.
  expect(await within(cajon).findByLabelText(/rol declarado de kant/i)).toBeInTheDocument();
}, 25_000);

/**
 * EL CONTROL NEGATIVO PRINCIPAL. Con el gateway sin publicar los ficheros —que es lo que pasa hoy
 * en producción— la pantalla NO puede decir «este alias no tiene CLAUDE.md»: no miró. Un negativo
 * que nadie midió no es un hecho del sistema, y de esos ya hubo demasiados acá.
 */
it('sin el endpoint publicado dice que NO MIRÓ, y NO afirma que falte el manual', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  // El handler por defecto ya devuelve 404; se deja explícito para que el caso se lea solo.
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json(
    { error: 'not_found', message: 'no publicado' }, { status: 404 },
  )));
  const cajon = await abrirDirectivaDeKant();

  const capa2 = within(cajon).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText(/no se pudo mirar el manual del sitio/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/no lo vio/i)).toBeInTheDocument();
  // La frase prohibida: afirmar la ausencia.
  expect(within(capa2).queryByText(/arranca cada sesión sin manual/i)).not.toBeInTheDocument();

  const capa3 = within(cajon).getByLabelText('Capa 3: memoria');
  expect(within(capa3).getByText(/no se pudo mirar la memoria/i)).toBeInTheDocument();

  // Y tampoco se inventa un aviso de solapamiento sobre ficheros que no se leyeron.
  expect(within(cajon).queryByRole('group', { name: /solapamiento/i })).not.toBeInTheDocument();
}, 25_000);

it('con el endpoint publicado enseña los CLAUDE.md, avisa del duplicado y lista la memoria', async () => {
  configConBrief('Sos kant, el hub. AUTONOMIA: decidí y actuá vos. Pedí permiso SOLO si hay dinero.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    observed_at: new Date().toISOString(),
    container_id: 'claw-kant',
    files: [
      {
        path: '~/.claude/CLAUDE.md', scope: 'user', bytes: 2079,
        modified_at: new Date().toISOString(),
        text: '# Flota\n\nAUTONOMIA: decidí y actuá vos.\n',
      },
      {
        path: '/workspace/CLAUDE.md', scope: 'workspace', bytes: 510,
        modified_at: new Date().toISOString(),
        text: '# Cauce V3\n\nEl repo vive en /workspace/cauce-v3.\n',
      },
    ],
    memory: { root: '~/.claude/projects', total: 267, truncated: true, entries: [{ path: 'MEMORY.md', bytes: 4200 }] },
  })));
  const cajon = await abrirDirectivaDeKant();

  const capa2 = within(cajon).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText('~/.claude/CLAUDE.md')).toBeInTheDocument();
  expect(within(capa2).getByText('/workspace/CLAUDE.md')).toBeInTheDocument();

  // El aviso de solapamiento: la autonomía escrita en dos capas, con el giro concreto de evidencia.
  const avisos = within(cajon).getByRole('group', { name: /solapamiento/i });
  expect(within(avisos).getByText(/la autonomía está escrita en dos capas/i)).toBeInTheDocument();
  expect(within(avisos).getAllByText('autonomía').length).toBeGreaterThan(0);
  // Y el caso janus: dos manuales a la vez.
  expect(within(avisos).getByText(/tiene 2 manuales a la vez/i)).toBeInTheDocument();

  // La memoria: índice, con el total REAL del servidor aunque la lista venga recortada.
  const capa3 = within(cajon).getByLabelText('Capa 3: memoria');
  expect(within(capa3).getByText('267')).toBeInTheDocument();
  expect(within(capa3).getByText('MEMORY.md')).toBeInTheDocument();
}, 25_000);

/**
 * CONTROL NEGATIVO del aviso: con las capas bien repartidas la pantalla no puede gritar. Un aviso
 * que sale siempre es un aviso que el operador aprende a ignorar, y entonces no avisa de nada.
 */
it('con la autonomía SÓLO en el rol y el manual limpio, no aparece ningún aviso de choque', async () => {
  configConBrief('Sos kant, el hub. AUTONOMIA: decidí y actuá vos. Pedí permiso SOLO si hay dinero.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    container_id: 'claw-kant',
    files: [{
      path: '~/.claude/CLAUDE.md', scope: 'user', bytes: 2079,
      text: '# Cauce V3\n\nEl repo vive en /workspace/cauce-v3. Se prueba con `pnpm test`.\n',
    }],
    memory: { root: '~/.claude/projects', total: 3, entries: [] },
  })));
  const cajon = await abrirDirectivaDeKant();

  await within(cajon).findByText('~/.claude/CLAUDE.md');
  expect(within(cajon).queryByText(/la autonomía está escrita en dos capas/i)).not.toBeInTheDocument();
  expect(within(cajon).queryByText(/manuales a la vez/i)).not.toBeInTheDocument();
  expect(within(cajon).queryByText(/arranca cada sesión sin manual/i)).not.toBeInTheDocument();
}, 25_000);

it('el caso gaia: el servidor MIRÓ y no hay manual, y eso sí se puede afirmar', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    container_id: 'claw-gaia', files: [], memory: { root: '~/.claude/projects', total: 2, entries: [] },
  })));
  const cajon = await abrirDirectivaDeKant();

  const capa2 = within(cajon).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText(/no hay ningún/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/arranca cada sesión sin manual del sitio/i)).toBeInTheDocument();
  // Y aquí sí: la afirmación de ausencia está permitida porque la lectura ocurrió.
  expect(within(capa2).queryByText(/no se pudo mirar/i)).not.toBeInTheDocument();
}, 25_000);
