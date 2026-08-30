import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';
import { RUTA_PERFIL, ackAplicado, perfilAplicado } from './perfil-fixtures';

/**
 * THE SEVEN FIELDS, TYPED THE WAY A PERSON TYPES THEM.
 *
 * The list fields are edited as text and stored as an array. Normalising that text on every
 * keystroke ate the space and the newline just pressed, so an entry of more than one word —or a
 * second entry— could not be written at all: `ssh a kratos` came out as `sshakratos`.
 */

function VistaDePerfil() {
  const [borrador, setBorrador] = useState<Partial<AgentPerfilCampos>>();
  return <PerfilTab tenantId="Steven" alias="kant" borrador={borrador} onBorrador={setBorrador} />;
}

function montarPerfil() {
  let actual = perfilAplicado();
  let recibido: Record<string, unknown> | undefined;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(actual)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      const body = await request.json() as { profile: AgentPerfil['perfil'] };
      recibido = body;
      actual = perfilAplicado(5, { perfil: body.profile });
      return HttpResponse.json(ackAplicado(5));
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<VistaDePerfil />);
  return { user, leerPut: () => recibido };
}

it('una entrada de lista admite espacios: escribir varias palabras no las pega', async () => {
  const { user } = montarPerfil();
  const caja = await screen.findByLabelText(/^Responsabilidades/i);

  await user.type(caja, 'Diagnosticar los fallos');

  expect(caja).toHaveValue('Diagnosticar los fallos');
});

it('un salto de línea abre una segunda entrada en vez de desaparecer al teclearlo', async () => {
  const { user } = montarPerfil();
  const caja = await screen.findByLabelText(/^Restricciones/i);

  await user.type(caja, 'No tocar credenciales{enter}No mandar secretos');

  expect(caja).toHaveValue('No tocar credenciales\nNo mandar secretos');
  expect(screen.getByText('2 entradas / 64')).toBeInTheDocument();
});

it('los siete campos viajan enteros en el PUT canónico', async () => {
  const { user, leerPut } = montarPerfil();

  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'El médico de la flota');
  await user.type(screen.getByLabelText(/^Rol declarado/i), 'Orquestador e infraestructura');
  await user.type(screen.getByLabelText(/^Tu humano y cómo tratarlo/i), 'Steven, sin rodeos');
  await user.type(screen.getByLabelText(/^Responsabilidades/i), 'Diagnosticar fallos{enter}Desplegar');
  await user.type(screen.getByLabelText(/^Restricciones/i), 'No tocar credenciales');
  await user.type(screen.getByLabelText(/^Herramientas/i), 'ssh a kratos{enter}docker de la flota');
  await user.type(screen.getByLabelText(/^Instrucciones fijas/i), 'Comprobá el efecto');

  await user.click(screen.getByRole('button', { name: /guardar y aplicar perfil/i }));

  await waitFor(() => { expect(leerPut()).toBeDefined(); });
  expect(leerPut()).toEqual({
    expected_revision: 4,
    profile: {
      purpose: 'El médico de la flota',
      role_summary: 'Orquestador e infraestructura',
      human_brief: 'Steven, sin rodeos',
      responsibilities: ['Diagnosticar fallos', 'Desplegar'],
      restrictions: ['No tocar credenciales'],
      tools: ['ssh a kratos', 'docker de la flota'],
      operating_rules: ['Comprobá el efecto'],
    },
  });
  expect(await screen.findByText(/acreditan la revisión 5/i)).toBeInTheDocument();
});

it('una línea en blanco entre entradas se puede teclear y no cuenta como entrada', async () => {
  const { user } = montarPerfil();
  const caja = await screen.findByLabelText(/^Herramientas/i);

  await user.type(caja, 'ssh a kratos{enter}{enter}docker');

  expect(caja).toHaveValue('ssh a kratos\n\ndocker');
  expect(screen.getByText('2 entradas / 64')).toBeInTheDocument();
});

it('sólo el salto de línea de más no cuenta como cambio: no habilita guardar', async () => {
  const { user } = montarPerfil();
  const caja = await screen.findByLabelText(/^Herramientas/i);
  await user.type(caja, 'docker');
  const boton = screen.getByRole('button', { name: /guardar y aplicar perfil/i });
  expect(boton).toBeEnabled();

  await user.clear(caja);

  expect(caja).toHaveValue('');
  expect(boton).toBeDisabled();
});
