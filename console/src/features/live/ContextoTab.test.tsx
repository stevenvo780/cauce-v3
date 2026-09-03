import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';
import { RUTA_PERFIL, ackAplicado, perfilAplicado } from './perfil-fixtures';

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
});

it('Contexto comparte una sola lectura de config.write entre perfil, manual y restauración', async () => {
  const user = userEvent.setup();
  let accessReads = 0;
  server.use(http.get('*/v3/console/access', () => {
    accessReads += 1;
    return HttpResponse.json({
      subject: 'Steven:kant',
      roles: ['operator'],
      permissions: ['config.write'],
    });
  }));

  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  expect(accessReads).toBe(0);

  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await within(cajon).findByRole('heading', { name: 'Campos canónicos' });
  await waitFor(() => { expect(accessReads).toBe(1); });

  await user.click(within(cajon).getByRole('button', { name: /abrir directiva completa/i }));
  await screen.findByRole('dialog', { name: /directiva de kant/i });
  expect(accessReads).toBe(1);
});

it('el cajón tiene un solo lugar de contexto y Ficheros nunca ofrece una mutación', async () => {
  const user = userEvent.setup();
  let puts = 0;
  server.use(http.put('*/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content', () => {
    puts += 1;
    return HttpResponse.json({ error: 'unexpected_put' }, { status: 500 });
  }));

  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  const navegacion = within(cajon).getByRole('tablist', { name: 'Secciones del detalle' });

  expect(within(navegacion).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Ahora', 'Conexión', 'Entregas', 'Contexto', 'Ficheros',
  ]);
  expect(within(navegacion).queryByRole('tab', { name: 'Directiva' })).not.toBeInTheDocument();
  expect(within(navegacion).queryByRole('tab', { name: 'Perfil' })).not.toBeInTheDocument();

  await user.click(within(navegacion).getByRole('tab', { name: 'Contexto' }));
  expect(await within(cajon).findByRole('heading', { name: 'Contexto efectivo' })).toBeInTheDocument();
  expect(within(cajon).getByRole('heading', { name: 'Campos canónicos' })).toBeInTheDocument();
  expect(within(cajon).getByRole('heading', { name: 'Manual del arnés' })).toBeInTheDocument();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByRole('button', { name: /^Guardar$/i })).toBeInTheDocument();

  await user.click(within(navegacion).getByRole('tab', { name: 'Ficheros' }));
  expect(await within(cajon).findByText(/inventario y visor de sólo lectura/i)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: 'Contexto' })).toBeInTheDocument();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i)).toHaveAttribute('readonly');
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();
  expect(puts).toBe(0);

  await user.click(within(cajon).getByRole('button', { name: 'Contexto' }));
  await waitFor(() => {
    expect(within(cajon).getByRole('heading', { name: 'Manual del arnés' }).closest('section'))
      .toHaveFocus();
  });
});

it('el enlace profundo legado perfil converge al id estable rol y selecciona Contexto', async () => {
  window.history.replaceState({}, '', '/live?agente=Steven%2Fkant&pestana=perfil');
  renderWithApi(<LiveFleetPage />);

  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  const navegacion = within(cajon).getByRole('tablist', { name: 'Secciones del detalle' });
  expect(within(navegacion).getByRole('tab', { name: 'Contexto' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => { expect(window.location.search).toContain('pestana=rol'); });
  expect(window.location.search).not.toContain('pestana=perfil');
  await waitFor(() => {
    expect(within(cajon).getByRole('heading', { name: 'Campos canónicos' }).closest('section'))
      .toHaveFocus();
  });
});

it('un borrador manual bloquea aplicar campos hasta guardarlo, sin perder ninguno', async () => {
  const user = userEvent.setup();
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado(4, {
      perfil: { ...perfilAplicado().perfil, role_summary: 'PMO de la flota.' },
    }))),
    http.put(
      '*/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content',
      async ({ request }) => {
        const body = await request.json() as { content: string };
        return HttpResponse.json({
          ok: true,
          state: 'applied',
          evidence: 'probe_write_ack',
          path: '/home/stev/.claude/CLAUDE.md',
          sha: 'a'.repeat(64),
          bytes: new TextEncoder().encode(body.content).byteLength,
        });
      },
    ),
  );
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));

  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const manual = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.type(manual, '\ntexto manual pendiente');
  const rol = within(cajon).getByLabelText(/^Rol declarado/i);
  await user.type(rol, ' cambio canónico');

  expect(within(cajon).getByText(/Hay un borrador manual pendiente/i)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
  expect((manual as HTMLTextAreaElement).value).toContain('texto manual pendiente');

  await user.type(
    within(cajon).getByLabelText(/Motivo del guardado/i), 'anoto el cambio del manual',
  );
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));
  await waitFor(() => {
    expect(within(cajon).queryByText(/Hay un borrador manual pendiente/i)).not.toBeInTheDocument();
  });
  expect(within(cajon).getByLabelText(/^Rol declarado/i))
    .toHaveValue('PMO de la flota. cambio canónico');
});

it('un perfil en vuelo bloquea empezar, guardar o descartar una edición manual hasta su ACK', async () => {
  const user = userEvent.setup();
  let actual = perfilAplicado(4);
  let putEmpezo = false;
  let soltarPerfil!: () => void;
  const perfilPendiente = new Promise<void>((resolve) => { soltarPerfil = resolve; });
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(actual)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: typeof actual.perfil };
      putEmpezo = true;
      await perfilPendiente;
      actual = perfilAplicado(5, { perfil: body.profile });
      return HttpResponse.json(ackAplicado(5));
    }),
  );

  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  let cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const manual = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  const manualAntes = (manual as HTMLTextAreaElement).value;
  await user.type(within(cajon).getByLabelText(/^Rol declarado/i), 'perfil nuevo');
  // Every profile save carries a hand-typed reason; without it the button does not even enable.
  await user.type(
    within(cajon).getByLabelText(/Motivo de este cambio de perfil/i), 'cambio el rol declarado',
  );
  await user.click(within(cajon).getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await waitFor(() => { expect(putEmpezo).toBe(true); });

  expect(manual).toHaveAttribute('readonly');
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();
  expect(within(cajon).getByRole('button', { name: /Descartar y releer/i })).toBeDisabled();
  expect(within(cajon).getByText(/manual queda bloqueado hasta recibir su ACK/i))
    .toBeInTheDocument();
  await user.type(manual, 'esto no debe entrar');
  expect(manual).toHaveValue(manualAntes);

  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveAttribute('readonly');
  expect(within(cajon).getByText(/manual queda bloqueado hasta recibir su ACK/i))
    .toBeInTheDocument();

  await user.click(within(cajon).getByRole('button', { name: /Cerrar el detalle/i }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: /detalle de kant/i })).not.toBeInTheDocument();
  });
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveAttribute('readonly');
  expect(within(cajon).getByLabelText(/^Rol declarado/i)).toBeDisabled();

  soltarPerfil();
  await waitFor(() => {
    expect(within(cajon).queryByText(/manual queda bloqueado hasta recibir su ACK/i))
      .not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(within(cajon).getByLabelText(/^Rol declarado/i)).toHaveValue('perfil nuevo');
  });

  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .not.toHaveAttribute('readonly');
});
