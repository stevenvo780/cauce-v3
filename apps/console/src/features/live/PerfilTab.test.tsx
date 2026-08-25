import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfil, AgentPerfilCampos, AgentPerfilValor } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';

const RUTA = 'http://localhost/v3/console/tenants/Steven/agents/kant/perfil';
const SHA = 'a'.repeat(64);

function respuesta(exists: boolean, overrides: Partial<AgentPerfil> = {}): Omit<AgentPerfil, 'publicado'> {
  const revision = exists ? 4 : null;
  return {
    tenant_id: 'Steven', alias: 'kant', agent_enabled: true, exists, revision,
    applied_revision: revision, runtime_state: exists ? 'applied' : 'absent', harness: 'codex',
    perfil: {
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
    medida: { unidades: 0, tope: 24_000 },
    base: 'fichero-vacio',
    ficheros: [{ nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
    ...overrides,
  };
}

function Vista() {
  const [borrador, setBorrador] = useState<Partial<AgentPerfilCampos>>();
  return <PerfilTab tenantId="Steven" alias="kant" borrador={borrador} onBorrador={setBorrador} />;
}

interface PutBody {
  expected_revision: number | null;
  profile: AgentPerfilValor;
}

function esPutBody(value: unknown): value is PutBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.expected_revision === null || typeof record.expected_revision === 'number')
    && record.profile !== null && typeof record.profile === 'object' && !Array.isArray(record.profile);
}

function ackAplicado(revision: number) {
  return {
    ok: true, state: 'applied', tenant_id: 'Steven', alias: 'kant', revision,
    applied_revision: revision,
    acknowledgements: [{
      name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', state: 'written',
      sha: SHA, bytes: 18,
    }],
  };
}

async function casoDeGuardado(existeAlAbrir: boolean) {
  let actual = respuesta(existeAlAbrir);
  let recibido: PutBody | undefined;
  server.use(
    http.get(RUTA, () => HttpResponse.json(actual)),
    http.put(RUTA, async ({ request }) => {
      const body: unknown = await request.json();
      if (!esPutBody(body)) return HttpResponse.json({ error: 'invalid_input' }, { status: 400 });
      recibido = body;
      const revision = existeAlAbrir ? 5 : 1;
      actual = {
        ...actual, exists: true, revision, applied_revision: revision,
        runtime_state: 'applied', perfil: body.profile,
      };
      return HttpResponse.json(ackAplicado(revision));
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  const caja = await screen.findByLabelText(/Identidad y propósito/i);
  await user.type(caja, 'coordinar la flota');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await waitFor(() => expect(recibido).toBeDefined());
  return recibido;
}

it('un perfil persistido vacío usa su revisión propia y sólo anuncia ACK aplicado completo', async () => {
  const recibido = await casoDeGuardado(true);
  expect(recibido).toEqual({
    expected_revision: 4,
    profile: {
      purpose: 'coordinar la flota', role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
  });
  expect(await screen.findByText(/Aplicado: desired y runtime acreditan la revisión 5/)).toBeInTheDocument();
  expect(screen.getByText(/1 ficheros respondieron SHA y bytes/)).toBeInTheDocument();
});

it('sólo usa expected_revision null cuando el servidor informó ausencia real', async () => {
  const recibido = await casoDeGuardado(false);
  expect(recibido?.expected_revision).toBeNull();
});

it('bloquea un gateway que omite la revisión en vez de perder el CAS', async () => {
  const body = respuesta(true) as Record<string, unknown>;
  delete body.revision;
  server.use(http.get(RUTA, () => HttpResponse.json(body)));
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  const caja = await screen.findByLabelText(/Identidad y propósito/i);
  await user.type(caja, 'no debe salir');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/presencia, revisión y estado/);
});

it('un alias disabled queda default-deny y no emite PUT', async () => {
  let puts = 0;
  server.use(
    http.get(RUTA, () => HttpResponse.json(respuesta(true, {
      agent_enabled: false, runtime_state: 'disabled',
    }))),
    http.put(RUTA, () => { puts += 1; return HttpResponse.json(ackAplicado(5)); }),
  );
  renderWithApi(<Vista />);
  expect(await screen.findByLabelText(/Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/Alias apagado/);
  expect(puts).toBe(0);
});

it('un desired pendiente se puede reintentar sin cambiar el texto', async () => {
  let actual = respuesta(true, { applied_revision: 3, runtime_state: 'pending' });
  let recibido: PutBody | undefined;
  server.use(
    http.get(RUTA, () => HttpResponse.json(actual)),
    http.put(RUTA, async ({ request }) => {
      const body: unknown = await request.json();
      if (!esPutBody(body)) return HttpResponse.json({ error: 'invalid_input' }, { status: 400 });
      recibido = body;
      actual = { ...actual, applied_revision: 4, runtime_state: 'applied' };
      return HttpResponse.json(ackAplicado(4));
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  expect(await screen.findByText(/Desired revisión 4 pendiente/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Reintentar aplicación/i }));
  await waitFor(() => expect(recibido?.expected_revision).toBe(4));
  expect(await screen.findByText(/Aplicado: desired y runtime acreditan la revisión 4/)).toBeInTheDocument();
});

it('un 2xx sin ACK completo conserva el borrador y no dice aplicado', async () => {
  server.use(
    http.get(RUTA, () => HttpResponse.json(respuesta(true))),
    http.put(RUTA, () => HttpResponse.json({ ok: true, state: 'applied', revision: 5 })),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  const caja = await screen.findByLabelText(/Identidad y propósito/i);
  await user.type(caja, 'sigue sucio');
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  expect(await screen.findByText(/devolvió 2xx, pero no acreditó/)).toBeInTheDocument();
  expect(caja).toHaveValue('sigue sucio');
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeEnabled();
});

it('el arnés se presenta como declarado, nunca como medido', async () => {
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true))));
  renderWithApi(<Vista />);
  expect(await screen.findByText(/Arnés declarado: codex/)).toBeInTheDocument();
  expect(screen.queryByText(/Arnés medido/)).not.toBeInTheDocument();
});
