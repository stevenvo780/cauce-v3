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

function mismatch(harness: string | null, reasons = ['expectation_sha_mismatch']) {
  server.use(http.get(RUTA, () => HttpResponse.json({
    ...respuesta(true, { runtime_state: 'drifted', harness }),
    contaminacion: { contaminated: true, findings: reasons.map((reason) => ({
      reason, document: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md',
    })) },
  })));
}

function respuesta(exists: boolean, overrides: Partial<AgentPerfil> = {}): Omit<AgentPerfil, 'publicado'> {
  const revision = exists ? 4 : null;
  return {
    tenant_id: 'Steven', alias: 'kant', agent_enabled: true, exists, revision,
    applied_revision: revision, runtime_state: exists ? 'applied' : 'absent', harness: 'codex',
    runtime_verification: exists ? {
      state: 'current', generation: 'gen-4', container_id: 'ws-kant',
      observed_at: '2026-08-26T00:00:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md',
        expected_sha: SHA, observed_sha: SHA, expected_bytes: 0, observed_bytes: 0,
        current: true,
      }],
    } : null,
    runtime_adoption: exists ? {
      evidence: 'adapter_delivery', revision: 4, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', sha: SHA,
      }],
    } : null,
    perfil: {
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
    medida: { unidades: 0, tope: 24_000 },
    base: exists ? 'runtime-medido' : 'fichero-vacio',
    ficheros: [{ nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
    ...overrides,
  };
}

function Vista({ configWritePermission = 'allowed' }: {
  configWritePermission?: 'allowed' | 'denied' | 'unknown';
}) {
  const [borrador, setBorrador] = useState<Partial<AgentPerfilCampos>>();
  return (
    <PerfilTab
      tenantId="Steven"
      alias="kant"
      borrador={borrador}
      onBorrador={setBorrador}
      configWritePermission={configWritePermission}
    />
  );
}

it.each(['codex', 'claude', 'openclaw'])('ofrece reconciliación solo para un arnés soportado: %s', async (harness) => {
  mismatch(harness);
  renderWithApi(<Vista />);
  expect(await screen.findByRole('region', { name: 'Reconciliar huellas del contexto' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Recargar contexto' })).toBeDisabled();
});

it.each(['hermes', null])('no ofrece una reconciliación imposible para %s', async (harness) => {
  mismatch(harness);
  renderWithApi(<Vista />);
  await screen.findByText(/huella distinta de la esperada/i);
  expect(screen.queryByRole('region', { name: 'Reconciliar huellas del contexto' })).toBeNull();
});

it.each([[], ['foreign_managed_block'], ['expectation_sha_mismatch', 'foreign_managed_block']].map((reasons) => ({ reasons })))(
  'no ofrece reconciliación con hallazgos vacíos, ajenos o mixtos: %j', async ({ reasons }) => {
    mismatch('codex', reasons);
    renderWithApi(<Vista />);
    await screen.findByText(/contienen algo que no es suyo/i);
    expect(screen.queryByRole('region', { name: 'Reconciliar huellas del contexto' })).toBeNull();
  },
);

it.each(['denied', 'unknown'] as const)('no mide ni reconcilia con permiso %s', async (permission) => {
  mismatch('codex');
  renderWithApi(<Vista configWritePermission={permission} />);
  expect(await screen.findByLabelText('Motivo de la reconciliación')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Medir antes de reconciliar' })).toBeDisabled();
});

it.each(['profile-draft', 'manual-draft', 'write-in-flight'])('no solapa la reconciliación con %s', async (blocker) => {
  mismatch('codex');
  renderWithApi(<PerfilTab tenantId="Steven" alias="kant" configWritePermission="allowed"
    onBorrador={() => undefined} borrador={blocker === 'profile-draft' ? { purpose: 'borrador pendiente' } : undefined}
    blockedByManualDraft={blocker === 'manual-draft'} writeInFlight={blocker === 'write-in-flight'} />);
  expect(await screen.findByLabelText('Motivo de la reconciliación')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Medir antes de reconciliar' })).toBeDisabled();
});

interface PutBody {
  expected_revision: number | null;
  profile: AgentPerfilValor;
  reason: string;
}

function esPutBody(value: unknown): value is PutBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.expected_revision === null || typeof record.expected_revision === 'number')
    && typeof record.reason === 'string'
    && record.profile !== null && typeof record.profile === 'object' && !Array.isArray(record.profile);
}

const MOTIVO = 'ajusto los campos canónicos';

async function motivar(user: ReturnType<typeof userEvent.setup>, texto = MOTIVO) {
  await user.type(screen.getByLabelText(/Motivo de este cambio de perfil/i), texto);
}

function ackAplicado(revision: number) {
  return {
    ok: true, state: 'applied', tenant_id: 'Steven', alias: 'kant', revision,
    applied_revision: revision,
    acknowledgements: [{
      name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', state: 'written',
      sha: SHA, bytes: 18, generation: 'gen-4', container_id: 'ws-kant',
    }],
    runtime_adoption: {
      evidence: 'adapter_delivery', revision, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', sha: SHA,
      }],
    },
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
        runtime_adoption: actual.runtime_adoption ? {
          ...actual.runtime_adoption, revision,
        } : null,
      };
      return HttpResponse.json(ackAplicado(revision));
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  const caja = await screen.findByLabelText(/Identidad y propósito/i);
  await user.type(caja, 'coordinar la flota');
  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  await waitFor(() => { expect(recibido).toBeDefined(); });
  return recibido;
}

it('un perfil persistido vacío usa su revisión propia y solo anuncia ACK aplicado completo', async () => {
  const recibido = await casoDeGuardado(true);
  expect(recibido).toEqual({
    expected_revision: 4,
    reason: MOTIVO,
    profile: {
      purpose: 'coordinar la flota', role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
  });
  expect(await screen.findByText(/Aplicado: la revisión deseada y el runtime acreditan la revisión 5/)).toBeInTheDocument();
  expect(screen.getByText(/1 ficheros respondieron SHA y bytes/)).toBeInTheDocument();
});

it('solo usa expected_revision null cuando el servidor informó ausencia real', async () => {
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
  expect(await screen.findByText(/La revisión deseada 4 pendiente/)).toBeInTheDocument();
  await motivar(user, 'reintento el lote pendiente');
  await user.click(screen.getByRole('button', { name: /Reintentar aplicación/i }));
  await waitFor(() => { expect(recibido?.expected_revision).toBe(4); });
  expect(await screen.findByText(/Aplicado: la revisión deseada y el runtime acreditan la revisión 4/)).toBeInTheDocument();
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
  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  expect(await screen.findByText(/devolvió 2xx, pero no acreditó/)).toBeInTheDocument();
  expect(caja).toHaveValue('sigue sucio');
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeEnabled();
});

it('permiso ausente o no acreditado bloquea caja y PUT', async () => {
  let puts = 0;
  server.use(
    http.get(RUTA, () => HttpResponse.json(respuesta(true))),
    http.put(RUTA, () => { puts += 1; return HttpResponse.json(ackAplicado(5)); }),
  );
  renderWithApi(<Vista configWritePermission="unknown" />);

  expect(await screen.findByLabelText(/Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByText(/No se pudo acreditar el permiso de escritura/)).toBeInTheDocument();
  expect(puts).toBe(0);
});

it('drift se pinta rojo y permite restaurar el lote sin cambiar texto', async () => {
  const baseResp = respuesta(true);
  const baseVerification = baseResp.runtime_verification ?? {
    state: 'current', generation: 'gen-4', container_id: 'ws-kant',
    observed_at: '2026-08-26T00:00:00Z',
    documents: [],
  };
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true, {
    runtime_state: 'drifted',
    runtime_verification: {
      ...baseVerification, state: 'drifted',
      documents: baseVerification.documents.map((document) => ({
        ...document, observed_sha: 'b'.repeat(64), current: false,
      })),
    },
  }))));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent(/SHA medidos.*no coinciden/i);
  expect(screen.getByRole('button', { name: /Reintentar aplicación/i })).toBeDisabled();
  await motivar(user, 'restauro el lote canónico');
  expect(screen.getByRole('button', { name: /Reintentar aplicación/i })).toBeEnabled();
});

it('runtime sin generación no se presenta aplicado ni deja editar', async () => {
  const baseResp = respuesta(true);
  const baseVerification = baseResp.runtime_verification ?? {
    state: 'current', generation: 'gen-4', container_id: 'ws-kant',
    observed_at: '2026-08-26T00:00:00Z',
    documents: [],
  };
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true, {
    runtime_state: 'runtime_unverified',
    runtime_verification: {
      ...baseVerification, state: 'unverified', generation: null,
    },
  }))));
  renderWithApi(<Vista />);

  expect(await screen.findByLabelText(/Identidad y propósito/i)).toBeDisabled();
  expect(screen.getByText(/no publicó una generación acreditable/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
});

it('ACK de disco sin adopción de TUI queda pendiente y no dice aplicado', async () => {
  let actual = respuesta(true);
  server.use(
    http.get(RUTA, () => HttpResponse.json(actual)),
    http.put(RUTA, async ({ request }) => {
      const body = await request.json() as { profile: typeof actual.perfil };
      actual = {
        ...actual, revision: 5, applied_revision: 4,
        runtime_state: 'pending_session_refresh', runtime_adoption: null,
        perfil: body.profile,
      };
      return HttpResponse.json({
        ...ackAplicado(5), state: 'pending_session_refresh', applied_revision: 4,
        runtime_adoption: null,
        runtime_verification: {
          ...actual.runtime_verification,
          documents: actual.runtime_verification?.documents.map((document) => ({ ...document, expected_bytes: 18, observed_bytes: 18 })),
        },
      }, { status: 202 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);
  const caja = await screen.findByLabelText(/Identidad y propósito/i);
  await user.type(caja, 'todavía pendiente');
  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));

  expect(await screen.findByText(/sesión compartida.*no acreditó recibir/i)).toBeInTheDocument();
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
});

it('sin un motivo escrito a mano no sale ningún PUT, aunque el borrador esté sucio', async () => {
  let puts = 0;
  server.use(
    http.get(RUTA, () => HttpResponse.json(respuesta(true))),
    http.put(RUTA, () => { puts += 1; return HttpResponse.json(ackAplicado(5)); }),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await user.type(await screen.findByLabelText(/Identidad y propósito/i), 'coordinar la flota');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue('');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();

  await motivar(user, 'corto');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();

  await motivar(user, ' pero ya no lo es');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeEnabled();
  expect(puts).toBe(0);
});

it('un contexto contaminado deja en cuarentena guardar y recargar, y nombra al dueño', async () => {
  let puts = 0;
  server.use(
    http.get(RUTA, () => HttpResponse.json({
      ...respuesta(true, { runtime_state: 'drifted' }),
      contaminacion: {
        contaminated: true,
        findings: [{
          reason: 'foreign_managed_block', document: 'AGENTS.md',
          path: '/home/kant/.codex/AGENTS.md', owner: 'Miguel/kratos',
        }],
      },
    })),
    http.put(RUTA, () => { puts += 1; return HttpResponse.json(ackAplicado(5)); }),
  );
  renderWithApi(<Vista />);

  const cuarentena = await screen.findByText(/contienen algo que no es suyo/i);
  expect(cuarentena).toBeInTheDocument();
  expect(screen.getByText(/bloque gestionado de otro alias/i)).toBeInTheDocument();
  expect(screen.getByText('Miguel/kratos')).toBeInTheDocument();

  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toBeDisabled();
  expect(screen.getByRole('button', { name: /Reintentar aplicación/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
  expect(puts).toBe(0);
});
