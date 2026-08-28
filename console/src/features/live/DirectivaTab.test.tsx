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
 * Igual que el perfil canónico: la mitad del encargo es DÓNDE vive. Un test del componente suelto
 * pasaría verde con la pestaña desenganchada del cajón, que es exactamente el defecto que hace que
 * nadie mantenga el `CLAUDE.md` —está, pero no hay por dónde llegar—.
 *
 * Los dos casos que importan son opuestos y los dos tienen que ser ciertos a la vez:
 *  · con el endpoint publicado, las tres capas se ven y el solapamiento se DICE;
 *  · sin el endpoint publicado, la pantalla declara que NO MIRÓ, y no puede afirmar ni que hay
 *    manual ni que no lo hay. Ese es el control negativo, y es el que esta consola ya falló antes
 *    en otras pantallas.
 *
 * Las capas se presentan en un diálogo (`role="dialog"`). Pruebas de foco, Escape, roles ARIA y contenido.
 */

import { configConBrief } from './agent-state-fixtures';

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

async function abrirPestanaDeKant() {
  const user = userEvent.setup();
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  return { user, cajon };
}

/** Abre el diálogo por el botón, que es el único camino que tiene el operador. */
async function abrirDirectivaDeKant() {
  const { user, cajon } = await abrirPestanaDeKant();
  const boton = await within(cajon).findByRole('button', { name: /abrir directiva completa/i });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  return { user, cajon, dialogo, boton };
}

/**
 * EL RESUMEN DEL CAJÓN. Se rompe si alguien vuelve a meter las capas dentro del cajón: las tres
 * secciones dejarían de estar detrás del botón y `Capa 2` aparecería sin haberlo pulsado.
 */
it('la pestaña deja en el cajón sólo el resumen del rol; las capas están detrás del botón', async () => {
  configConBrief('Sos kant, el hub de la flota.\nAUTONOMIA: decidí y actuá vos.\nEscalá a Steven si hay dinero.');
  const { cajon } = await abrirPestanaDeKant();

  // Las dos primeras líneas del rol, y NO la tercera.
  expect(await within(cajon).findByText('Sos kant, el hub de la flota.')).toBeInTheDocument();
  expect(within(cajon).getByText('AUTONOMIA: decidí y actuá vos.')).toBeInTheDocument();
  expect(within(cajon).queryByText('Escalá a Steven si hay dinero.')).not.toBeInTheDocument();

  // El contador, en PUNTOS DE CÓDIGO y sobre el texto recortado: lo mismo que cuenta el CHECK de
  // la base. 91 son los tres renglones de arriba; contar unidades UTF-16 daría otro número el día
  // que alguien pegue un emoji, y ése es el número que deja al alias sordo.
  expect(within(cajon).getByText('91')).toBeInTheDocument();

  // Y ni una capa dentro del cajón mientras el diálogo no se abra.
  expect(within(cajon).queryByLabelText('Capa 2: manual del sitio')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('la directiva rotula las TRES capas por su fin, no sólo por su nombre técnico', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { dialogo } = await abrirDirectivaDeKant();

  // Los tres rótulos son las tres preguntas que deciden dónde va a parar cada frase.
  expect(await within(dialogo).findByText('QUIÉN SOS y QUÉ PODÉS DECIDIR')).toBeInTheDocument();
  expect(within(dialogo).getByText('CÓMO SE TRABAJA AQUÍ')).toBeInTheDocument();
  expect(within(dialogo).getByText('LO QUE ESE AGENTE APRENDIÓ')).toBeInTheDocument();

  // La capa 1 conserva la misma proyección, sin reabrir un editor legacy.
  expect(await within(dialogo).findByLabelText(/proyección del rol de kant/i)).toHaveAttribute('readonly');
}, 25_000);

it('los avisos y el rol visible consumen un único snapshot aunque el siguiente GET ya sea otra revisión', async () => {
  const snapshotA = 'Sos kant. AUTONOMIA: decidí y actuá vos.';
  const snapshotB = 'Sos kant. Esperá siempre una orden antes de actuar.';
  let lecturasDeConfig = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      lecturasDeConfig += 1;
      const roleBrief = lecturasDeConfig === 1 ? snapshotA : snapshotB;
      return HttpResponse.json({
        revision: lecturasDeConfig,
        observed_at: new Date().toISOString(),
        agents: [
          { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true, role_brief: roleBrief },
        ],
        tenants: [], rooms: [], memberships: [], acl_edges: [], harness_definitions: [],
        role_policies: [], chain_policies: [], egress_destinations: [], provider_accounts: [],
        alias_routing_ceiling: [], agent_account_bindings: [], revisions: [],
      });
    }),
    http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
      publicado: true,
      medido: true,
      container_id: 'claw-kant',
      files: [{
        path: '~/.claude/CLAUDE.md', scope: 'user', bytes: 64,
        text: '# Manual\n\nAUTONOMIA: decidí y actuá vos.\n',
      }],
      memory: { root: '~/.claude/projects', total: 0, entries: [] },
    })),
  );

  const { dialogo } = await abrirDirectivaDeKant();
  const capa1 = within(dialogo).getByLabelText('Capa 1: rol declarado');

  expect(await within(capa1).findByLabelText(/proyección del rol de kant/i)).toHaveValue(snapshotA);
  expect(within(dialogo).getByText(/la autonomía está escrita en dos capas/i)).toBeInTheDocument();
  expect(within(dialogo).queryByDisplayValue(snapshotB)).not.toBeInTheDocument();
  expect(lecturasDeConfig).toBe(1);
}, 25_000);

/**
 * LA PROSA SE PLIEGA. Lo que queda SIEMPRE a la vista es lo que hace falta para decidir en qué
 * capa va una frase: el fin y la fuente. El porqué está, pero cerrado.
 *
 * Se rompe si alguien saca los párrafos del `<details>`: el texto pasaría a estar visible sin
 * haber abierto nada, y volverían los ~600 px que este cambio recortó.
 */
it('el porqué de cada capa está plegado y el fin de cada capa no', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { user, dialogo } = await abrirDirectivaDeKant();

  const capa1 = within(dialogo).getByLabelText('Capa 1: rol declarado');
  const porque = within(capa1).getByText(/es la única capa que sigue siendo verdad/i);
  // `<details>` cerrado: jsdom no hace layout, pero sí respeta el atributo `open`.
  expect(porque.closest('details')?.open).toBe(false);
  expect(within(capa1).getByText('QUIÉN SOS y QUÉ PODÉS DECIDIR')).toBeVisible();

  await user.click(within(capa1).getByText('¿por qué esta capa?'));
  expect(porque.closest('details')?.open).toBe(true);
});

/** La capa 4 es una nota de alcance en el pie, plegada. Medía 679 px abierta y no es una capa. */
it('lo que todavía no se puede hacer está en el pie y plegado, no como cuarta capa', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { dialogo } = await abrirDirectivaDeKant();

  const resumen = within(dialogo).getByText(/lo que todavía no se puede desde aquí/i);
  expect(resumen.closest('details')?.open).toBe(false);
  expect(within(dialogo).queryByLabelText(/Capa 4/i)).not.toBeInTheDocument();
});

/**
 * Control negativo: sin el endpoint de directiva publicado, se indica que no se miró
 * sin asumir ausencia del manual.
 */
it('sin el endpoint publicado dice que NO MIRÓ, y NO afirma que falte el manual', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  // El handler por defecto ya devuelve 404; se deja explícito para que el caso se lea solo.
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () =>
    new HttpResponse(null, { status: 404 })));
  const { dialogo } = await abrirDirectivaDeKant();

  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText(/no se pudo mirar el manual del sitio/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/todavía no publica esta lectura/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/no lo vio/i)).toBeInTheDocument();
  // La frase prohibida: afirmar la ausencia.
  expect(within(capa2).queryByText(/arranca cada sesión sin manual/i)).not.toBeInTheDocument();
  // Y se ve DISTINTO del caso medido: es el marcador que separa un diagnóstico de una invención.
  expect(within(capa2).getByText(/no se pudo mirar el manual del sitio/i).closest('.directiva-lectura'))
    .toHaveAttribute('data-medicion', 'no-medida');

  const capa3 = within(dialogo).getByLabelText('Capa 3: memoria');
  expect(within(capa3).getByText(/no se pudo mirar la memoria/i)).toBeInTheDocument();

  // Y tampoco se inventa un aviso de solapamiento sobre ficheros que no se leyeron.
  expect(within(dialogo).queryByRole('group', { name: /solapamiento/i })).not.toBeInTheDocument();
}, 25_000);

it('un 404 not_found del alias se muestra como recurso ausente, no como endpoint viejo', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json(
    { error: 'not_found', message: 'agent not found or not visible' }, { status: 404 },
  )));
  const { dialogo } = await abrirDirectivaDeKant();
  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');

  expect(await within(capa2).findByText(/agent not found or not visible/i)).toBeInTheDocument();
  expect(within(capa2).queryByText(/gateway todavía no publica/i)).not.toBeInTheDocument();
});

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
  const { dialogo } = await abrirDirectivaDeKant();

  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText('~/.claude/CLAUDE.md')).toBeInTheDocument();
  expect(within(capa2).getByText('/workspace/CLAUDE.md')).toBeInTheDocument();

  // El aviso de solapamiento: la autonomía escrita en dos capas, con el giro concreto de evidencia.
  const avisos = within(dialogo).getByRole('group', { name: /solapamiento/i });
  expect(within(avisos).getByText(/la autonomía está escrita en dos capas/i)).toBeInTheDocument();
  expect(within(avisos).getAllByText('autonomía').length).toBeGreaterThan(0);
  // Y el caso janus: dos manuales a la vez.
  expect(within(avisos).getByText(/carga 2 manuales/i)).toBeInTheDocument();
  expect(within(avisos).getByText(/orden medido por el runtime/i)).toBeInTheDocument();

  // La memoria: índice, con el total REAL del servidor aunque la lista venga recortada.
  const capa3 = within(dialogo).getByLabelText('Capa 3: memoria');
  expect(within(capa3).getByText('267')).toBeInTheDocument();
  expect(within(capa3).getByText('MEMORY.md')).toBeInTheDocument();
}, 25_000);

it('un cap de barrido se muestra como límite inferior y no como total exacto', async () => {
  configConBrief('Sos kant, el hub. AUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    publicado: true,
    medido: true,
    container_id: 'claw-kant',
    files: [],
    memory: {
      root: '~/.claude/projects',
      total: null,
      observed_at_least: 5_000,
      truncated: true,
      entries: [],
    },
  })));
  const { dialogo } = await abrirDirectivaDeKant();
  const capa3 = within(dialogo).getByLabelText('Capa 3: memoria');

  expect(await within(capa3).findByText('≥ 5000')).toBeInTheDocument();
  expect(within(capa3).getByText(/se observaron como mínimo 5000/i)).toBeInTheDocument();
  expect(within(capa3).queryByText(/no tiene memoria escrita/i)).not.toBeInTheDocument();
}, 25_000);

it('un fallo discriminado de memoria muestra su causa y no un índice vacío', async () => {
  configConBrief('Sos kant, el hub. AUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    publicado: true,
    medido: true,
    container_id: 'claw-kant',
    files: [],
    memory: {
      root: '~/.claude/projects',
      error: 'timeout',
      reason: 'el pty-agent no contestó el índice',
    },
  })));
  const { dialogo } = await abrirDirectivaDeKant();
  const capa3 = within(dialogo).getByLabelText('Capa 3: memoria');

  expect(await within(capa3).findByText(/el pty-agent no contestó el índice/i)).toBeInTheDocument();
  expect(within(capa3).queryByText(/no tiene memoria escrita/i)).not.toBeInTheDocument();
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
  const { dialogo } = await abrirDirectivaDeKant();

  await within(dialogo).findByText('~/.claude/CLAUDE.md');
  expect(within(dialogo).queryByText(/la autonomía está escrita en dos capas/i)).not.toBeInTheDocument();
  expect(within(dialogo).queryByText(/manuales a la vez/i)).not.toBeInTheDocument();
  expect(within(dialogo).queryByText(/arranca cada sesión sin manual/i)).not.toBeInTheDocument();
}, 25_000);

it('el caso gaia: el servidor MIRÓ y no hay manual, y eso sí se puede afirmar', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () => HttpResponse.json({
    container_id: 'claw-gaia', files: [], memory: { root: '~/.claude/projects', total: 2, entries: [] },
  })));
  const { dialogo } = await abrirDirectivaDeKant();

  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText(/no hay ningún/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/no hay ningún manual estándar acreditado/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/no prueba ausencia de reglas o fallbacks/i)).toBeInTheDocument();
  // Y aquí sí: la afirmación de ausencia está permitida porque la lectura ocurrió.
  expect(within(capa2).queryByText(/no se pudo mirar/i)).not.toBeInTheDocument();
  // El otro marcador, el que hace que los dos estados no se confundan de un vistazo.
  expect(within(capa2).getByText(/el servidor miró/i).closest('.directiva-lectura'))
    .toHaveAttribute('data-medicion', 'medida-vacia');
}, 25_000);
