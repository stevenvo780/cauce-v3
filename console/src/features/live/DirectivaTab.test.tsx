import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * THE THREE LAYERS, TESTED FROM THE LIVE PAGE.
 *
 * Like the canonical profile: half of the task is WHERE it lives. A loose component test would
 * pass green with the tab detached from the drawer, which is exactly the bug that means nobody
 * maintains the `CLAUDE.md` — it is there, but there is no way to get to it.
 *
 * The two cases that matter are opposite and both have to be true at the same time:
 *  · with the endpoint published, the three layers are seen and the overlap is STATED;
 *  · without the endpoint published, the screen declares that it DID NOT LOOK, and cannot
 *    assert either that there is a manual or that there is not. That is the negative control,
 *    and it is the one this console already failed before on other screens.
 *
 * Layers are presented in a dialog (`role="dialog"`). Tests of focus, Escape, ARIA roles and content.
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
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  return { user, cajon };
}

/** Open the dialog via the button, which is the only path the operator has. */
async function abrirDirectivaDeKant() {
  const { user, cajon } = await abrirPestanaDeKant();
  const boton = await within(cajon).findByRole('button', { name: /abrir directiva completa/i });
  await user.click(boton);
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  return { user, cajon, dialogo, boton };
}

/**
 * THE DRAWER SUMMARY. It breaks if someone puts the layers back inside the drawer: the three
 * sections would stop being behind the button and `Capa 2` would show without clicking.
 */
it('la pestaña deja en el cajón sólo el resumen del rol; las capas están detrás del botón', async () => {
  configConBrief('Sos kant, el hub de la flota.\nAUTONOMIA: decidí y actuá vos.\nEscalá a Steven si hay dinero.');
  const { cajon } = await abrirPestanaDeKant();

  // The first two lines of the role, and NOT the third.
  expect(await within(cajon).findByText('Sos kant, el hub de la flota.')).toBeInTheDocument();
  expect(within(cajon).getByText('AUTONOMIA: decidí y actuá vos.')).toBeInTheDocument();
  expect(within(cajon).queryByText('Escalá a Steven si hay dinero.')).not.toBeInTheDocument();

  // The counter, in CODE POINTS and over the trimmed text: the same as the database CHECK
  // counts. 91 is the three lines above; counting UTF-16 units would give another number the
  // day someone pastes an emoji, and that is the number that leaves the alias deaf.
  expect(within(cajon).getByText('91')).toBeInTheDocument();

  // And not a single layer inside the drawer while the dialog has not been opened.
  expect(within(cajon).queryByLabelText('Capa 2: manual del sitio')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: /directiva de kant/i })).not.toBeInTheDocument();
});

it('la directiva rotula las TRES capas por su fin, no sólo por su nombre técnico', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { dialogo } = await abrirDirectivaDeKant();

  // The three labels are the three questions that decide where each sentence goes.
  expect(await within(dialogo).findByText('QUIÉN SOS y QUÉ PODÉS DECIDIR')).toBeInTheDocument();
  expect(within(dialogo).getByText('CÓMO SE TRABAJA AQUÍ')).toBeInTheDocument();
  expect(within(dialogo).getByText('LO QUE ESE AGENTE APRENDIÓ')).toBeInTheDocument();

  // Layer 1 keeps the same projection, without reopening a legacy editor.
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
 * THE PROSE FOLDS. What stays ALWAYS in view is what is needed to decide which layer a
 * sentence goes into: the purpose and the source. The why is there, but closed.
 *
 * It breaks if someone pulls the paragraphs out of the `<details>`: the text would become
 * visible without anything being opened, and the ~600 px this change trimmed would come back.
 */
it('el porqué de cada capa está plegado y el fin de cada capa no', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { user, dialogo } = await abrirDirectivaDeKant();

  const capa1 = within(dialogo).getByLabelText('Capa 1: rol declarado');
  const porque = within(capa1).getByText(/es la única capa que sigue siendo verdad/i);
  // `<details>` closed: jsdom does not do layout, but it does respect the `open` attribute.
  expect(porque.closest('details')?.open).toBe(false);
  expect(within(capa1).getByText('QUIÉN SOS y QUÉ PODÉS DECIDIR')).toBeVisible();

  await user.click(within(capa1).getByText('¿por qué esta capa?'));
  expect(porque.closest('details')?.open).toBe(true);
});

/** Layer 4 is a scope note in the footer, folded. It measured 679 px open and it is not a layer. */
it('lo que todavía no se puede hacer está en el pie y plegado, no como cuarta capa', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  const { dialogo } = await abrirDirectivaDeKant();

  const resumen = within(dialogo).getByText(/lo que todavía no se puede desde aquí/i);
  expect(resumen.closest('details')?.open).toBe(false);
  expect(within(dialogo).queryByLabelText(/Capa 4/i)).not.toBeInTheDocument();
});

/**
 * Negative control: without the directive endpoint published, it is indicated that the manual
 * was not looked at, without assuming its absence.
 */
it('sin el endpoint publicado dice que NO MIRÓ, y NO afirma que falte el manual', async () => {
  configConBrief('Sos kant. AUTONOMIA: decidí y actuá vos.');
  // The default handler already returns 404; left explicit so the case reads by itself.
  server.use(http.get('*/v3/console/agents/:tenantId/:alias/directive', () =>
    new HttpResponse(null, { status: 404 })));
  const { dialogo } = await abrirDirectivaDeKant();

  const capa2 = within(dialogo).getByLabelText('Capa 2: manual del sitio');
  expect(await within(capa2).findByText(/no se pudo mirar el manual del sitio/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/todavía no publica esta lectura/i)).toBeInTheDocument();
  expect(within(capa2).getByText(/no lo vio/i)).toBeInTheDocument();
  // La frase prohibida: afirmar la ausencia.
  expect(within(capa2).queryByText(/arranca cada sesión sin manual/i)).not.toBeInTheDocument();
  // And it looks DIFFERENT from the measured case: it is the marker that separates a diagnosis
  // from an invention.
  expect(within(capa2).getByText(/no se pudo mirar el manual del sitio/i).closest('.directiva-lectura'))
    .toHaveAttribute('data-medicion', 'no-medida');

  const capa3 = within(dialogo).getByLabelText('Capa 3: memoria');
  expect(within(capa3).getByText(/no se pudo mirar la memoria/i)).toBeInTheDocument();

  // And neither is an overlap warning invented over files that were not read.
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

  // The overlap warning: autonomy written in two layers, with the specific turn of evidence.
  const avisos = within(dialogo).getByRole('group', { name: /solapamiento/i });
  expect(within(avisos).getByText(/la autonomía está escrita en dos capas/i)).toBeInTheDocument();
  expect(within(avisos).getAllByText('autonomía').length).toBeGreaterThan(0);
  // And the case of two manuals at once.
  expect(within(avisos).getByText(/carga 2 manuales/i)).toBeInTheDocument();
  expect(within(avisos).getByText(/orden medido por el runtime/i)).toBeInTheDocument();

  // The memory: index, with the REAL server total even if the list comes truncated.
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
 * NEGATIVE CONTROL of the warning: with the layers well distributed the screen cannot scream.
 * A warning that always shows is a warning the operator learns to ignore, and then it warns
 * of nothing.
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
  // And here yes: the absence assertion is allowed because the read happened.
  expect(within(capa2).queryByText(/no se pudo mirar/i)).not.toBeInTheDocument();
  // The other marker, the one that keeps the two states from being confused at a glance.
  expect(within(capa2).getByText(/el servidor miró/i).closest('.directiva-lectura'))
    .toHaveAttribute('data-medicion', 'medida-vacia');
}, 25_000);
