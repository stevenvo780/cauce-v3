import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfilCampos } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';
import { RUTA_PERFIL, perfilAplicado } from './perfil-fixtures';

/**
 * WHAT THE EDITOR DOES WHEN THE SAVE IS REJECTED.
 *
 * The rule is the same for every status and it is the whole point of these tests: the typed text
 * is NOT thrown away, the server's own reason is shown, and nothing is presented as applied. A
 * screen that swallows the draft after a 409 teaches the operator to copy their text elsewhere
 * before clicking, which is the same as not having an editor.
 */

function VistaDePerfil() {
  const [borrador, setBorrador] = useState<Partial<AgentPerfilCampos>>();
  return (
    <PerfilTab
      tenantId="Steven"
      alias="kant"
      borrador={borrador}
      onBorrador={setBorrador}
      configWritePermission="allowed"
    />
  );
}

const MOTIVO = 'declaro la identidad del alias';

function rechazaCon(status: number, cuerpo: Record<string, unknown>) {
  let intentos = 0;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado())),
    http.put(RUTA_PERFIL, () => {
      intentos += 1;
      return HttpResponse.json(cuerpo, { status });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<VistaDePerfil />);
  return { user, leerIntentos: () => intentos };
}

async function escribirYGuardar(user: ReturnType<typeof userEvent.setup>) {
  const caja = await screen.findByLabelText(/^Identidad y propósito/i);
  await user.type(caja, 'el médico de la flota');
  await user.type(screen.getByLabelText(/Motivo de este cambio de perfil/i), MOTIVO);
  await user.click(screen.getByRole('button', { name: /guardar y aplicar perfil/i }));
  return caja;
}

it('un 409 de revisión conserva el borrador y repite el motivo del servidor', async () => {
  const { user } = rechazaCon(409, {
    error: 'profile_revision_conflict', message: 'el perfil cambió desde que se abrió',
    revision: 6, applied_revision: 6,
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/el perfil cambió desde que se abrió/i)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
});

it('un 422 de campo inválido se muestra tal cual, sin traducirlo a «no se pudo»', async () => {
  const { user } = rechazaCon(422, {
    error: 'invalid_input', field: 'purpose', message: 'purpose supera el tope de 2000 unidades',
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/purpose supera el tope de 2000 unidades/i)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
});

it('un 403 del gateway no se presenta como guardado ni vacía la caja', async () => {
  const { user } = rechazaCon(403, {
    error: 'forbidden', message: 'la sesión no tiene control sobre este alias',
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/la sesión no tiene control sobre este alias/i)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
});

it('un 503 sin saga de perfil se cuenta como lo que es, y se puede reintentar', async () => {
  const { user, leerIntentos } = rechazaCon(503, {
    error: 'profile_write_unavailable',
    message: 'este gateway no tiene montada la saga durable de perfil y runtime',
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/saga durable de perfil y runtime/i)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /guardar y aplicar perfil/i }));
  await waitFor(() => { expect(leerIntentos()).toBe(2); });
  expect(caja).toHaveValue('el médico de la flota');
});

it('un gateway que no publica el perfil lo dice, y no pinta un editor vacío', async () => {
  server.use(http.get(RUTA_PERFIL, () => new HttpResponse(null, { status: 501 })));
  renderWithApi(<VistaDePerfil />);

  expect(await screen.findByText(/no publica GET/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/^Identidad y propósito/i)).not.toBeInTheDocument();
});

it('un fallo de lectura no se disfraza de perfil vacío', async () => {
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(
    { error: 'internal', message: 'la base no respondió' }, { status: 500 },
  )));
  renderWithApi(<VistaDePerfil />);

  expect(await screen.findByText(/no se pudo leer el perfil/i)).toBeInTheDocument();
  expect(screen.getByText(/la base no respondió/i)).toBeInTheDocument();
});

it('un 400 que nombra `reason` dice el rango y qué hacer, sin volcar el JSON', async () => {
  const { user } = rechazaCon(400, {
    error: 'invalid_input', field: 'reason',
    message: '`reason` tiene que ser un motivo escrito a mano de entre 8 y 280 caracteres',
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/La auditoría no admitió este guardado/i)).toBeInTheDocument();
  expect(screen.getByText(/entre 8 y 280 caracteres/)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue(MOTIVO);
});

it('CONTROL NEGATIVO: un 400 de otro campo conserva el mensaje del servidor', async () => {
  const { user } = rechazaCon(400, {
    error: 'invalid_input', field: 'purpose', message: 'purpose supera el tope de 2000 unidades',
  });
  await escribirYGuardar(user);

  expect(await screen.findByText(/purpose supera el tope de 2000 unidades/i)).toBeInTheDocument();
  expect(screen.queryByText(/La auditoría no admitió este guardado/i)).not.toBeInTheDocument();
});

it('una sesión sin persona detrás lo dice en castellano y conserva texto y motivo', async () => {
  const { user } = rechazaCon(403, {
    error: 'forbidden', reason: 'writable_requires_attribution',
    message: 'escribir la gobernanza de un alias exige una persona con nombre',
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/no acredita a la persona que escribe/i)).toBeInTheDocument();
  expect(screen.getByText(/identidad de operador/i)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue(MOTIVO);
});

it('un 409 de cuarentena nombra el bloque ajeno y bloquea el siguiente intento', async () => {
  const { user, leerIntentos } = rechazaCon(409, {
    error: 'context_contaminated',
    message: 'los ficheros de gobierno de este alias contienen algo que no es suyo',
    contaminacion: {
      contaminated: true,
      findings: [{
        reason: 'expectation_sha_mismatch', document: 'AGENTS.md',
        path: '/home/kant/.codex/AGENTS.md',
        expected_sha: 'a'.repeat(64), observed_sha: 'b'.repeat(64),
      }],
    },
  });
  const caja = await escribirYGuardar(user);

  expect(await screen.findByText(/huella distinta de la esperada/i)).toBeInTheDocument();
  expect(caja).toHaveValue('el médico de la flota');
  expect(screen.getByRole('button', { name: /guardar y aplicar perfil/i })).toBeDisabled();
  expect(leerIntentos()).toBe(1);
});
