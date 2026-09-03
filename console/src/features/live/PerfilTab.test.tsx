import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfil, AgentPerfilCampos, AgentPerfilValor } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { PerfilTab } from './PerfilTab';

const RUTA = 'http://localhost/v3/console/tenants/Steven/agents/kant/perfil';
const RECARGA = 'http://localhost/v3/console/tenants/Steven/agents/kant/context/reload';
const SHA = 'a'.repeat(64);

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

it('un perfil persistido vacío usa su revisión propia y sólo anuncia ACK aplicado completo', async () => {
  const recibido = await casoDeGuardado(true);
  expect(recibido).toEqual({
    expected_revision: 4,
    reason: MOTIVO,
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
  await motivar(user, 'reintento el lote pendiente');
  await user.click(screen.getByRole('button', { name: /Reintentar aplicación/i }));
  await waitFor(() => { expect(recibido?.expected_revision).toBe(4); });
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
  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Guardar y aplicar perfil/i }));
  expect(await screen.findByText(/devolvió 2xx, pero no acreditó/)).toBeInTheDocument();
  expect(caja).toHaveValue('sigue sucio');
  expect(screen.queryByText(/^Aplicado:/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeEnabled();
});

it('el arnés medido y la base viva se rotulan como tales', async () => {
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true))));
  renderWithApi(<Vista />);
  expect(await screen.findByText(/Arnés medido: codex/)).toBeInTheDocument();
  expect(screen.queryByText(/Arnés declarado/)).not.toBeInTheDocument();
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
    http.put(RUTA, () => {
      actual = {
        ...actual, revision: 5, applied_revision: 4,
        runtime_state: 'pending_session_refresh', runtime_adoption: null,
      };
      return HttpResponse.json({
        ...ackAplicado(5), state: 'pending_session_refresh', applied_revision: 4,
        runtime_adoption: null,
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

/**
 * THE DESTINATION OF EACH FIELD.
 *
 * The bug they fix: the label said "SOUL.md en openclaw" to an alias whose harness is
 * `claude` and whose only file is `CLAUDE.md`. A label that names a file nobody will write is
 * worse than no label at all: the operator believes they know where what they write ends up.
 */
function rotuloDe(titulo: RegExp): string {
  const caja = screen.getByLabelText(titulo);
  return caja.closest('label')?.textContent ?? '';
}

async function abrirCon(overrides: Partial<AgentPerfil>) {
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true, overrides))));
  renderWithApi(<Vista />);
  await screen.findByLabelText(/Identidad y propósito/i);
}

const FICHEROS_OPENCLAW_MOCK = [
  'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md',
].map((nombre) => ({
  nombre,
  politica: nombre === 'MEMORY.md' || nombre === 'HEARTBEAT.md'
    ? 'solo-si-falta' as const
    : 'bloque-gestionado' as const,
  texto: '', unidades: 0,
}));

it('un alias claude ve CLAUDE.md en los siete campos y NINGÚN fichero de openclaw', async () => {
  await abrirCon({
    harness: 'claude',
    ficheros: [{ nombre: 'CLAUDE.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
  });
  for (const titulo of [
    /Identidad y propósito/i, /Rol declarado/i, /Tu humano y cómo tratarlo/i,
    /Responsabilidades/i, /Restricciones/i, /Herramientas/i,
    /Instrucciones fijas de funcionamiento/i,
  ]) {
    expect(rotuloDe(titulo)).toContain('→ CLAUDE.md');
  }
  const editor = screen.getByText(/Campos canónicos de kant/i).closest('section');
  for (const ajeno of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'openclaw']) {
    expect(editor?.textContent ?? '').not.toContain(ajeno);
  }
});

it('un alias openclaw reparte los campos entre sus cinco ficheros gobernados', async () => {
  await abrirCon({ harness: 'openclaw', ficheros: FICHEROS_OPENCLAW_MOCK });
  expect(rotuloDe(/Identidad y propósito/i)).toContain('→ SOUL.md');
  expect(rotuloDe(/Rol declarado/i)).toContain('→ IDENTITY.md');
  expect(rotuloDe(/Tu humano y cómo tratarlo/i)).toContain('→ USER.md');
  expect(rotuloDe(/Responsabilidades/i)).toContain('→ AGENTS.md');
  expect(rotuloDe(/Restricciones/i)).toContain('→ AGENTS.md');
  expect(rotuloDe(/^Herramientas/i)).toContain('→ TOOLS.md');
  expect(rotuloDe(/Instrucciones fijas de funcionamiento/i)).toContain('→ AGENTS.md');
});

it('un alias codex junta los siete campos en AGENTS.md, sin nombrar ficheros ajenos', async () => {
  await abrirCon({ harness: 'codex' });
  expect(rotuloDe(/Identidad y propósito/i)).toContain('→ AGENTS.md');
  expect(rotuloDe(/^Herramientas/i)).toContain('→ AGENTS.md');
  expect(screen.getByText(/Campos canónicos de kant/i).closest('section')?.textContent ?? '')
    .not.toContain('TOOLS.md');
});

it('sin arnés declarado dice «sin dato» y lo explica una vez, en vez de adivinar openclaw', async () => {
  await abrirCon({ harness: null, ficheros: [] });
  expect(rotuloDe(/Identidad y propósito/i)).toContain('sin dato');
  expect(screen.getByText(/Ningún campo tiene un fichero de destino/i).textContent)
    .toContain('no dice qué arnés');
  expect(screen.getByText(/Campos canónicos de kant/i).closest('section')?.textContent ?? '')
    .not.toContain('SOUL.md');
});

it('un arnés que Cauce no sabe componer se marca «no aplica» y se nombra en la explicación', async () => {
  await abrirCon({ harness: 'hermes', ficheros: [] });
  expect(screen.getAllByLabelText('no aplica').length).toBe(7);
  expect(screen.getByText(/Ningún campo tiene un fichero de destino/i).textContent)
    .toContain('hermes');
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

function VistaConRestauracion() {
  const [borrador, setBorrador] = useState<Partial<AgentPerfilCampos>>();
  const [restauracion, setRestauracion] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => { setBorrador({ role_summary: 'Rol 2' }); setRestauracion((n) => n + 1); }}
      >
        simular restauración
      </button>
      <PerfilTab
        tenantId="Steven"
        alias="kant"
        borrador={borrador}
        onBorrador={setBorrador}
        restauracion={restauracion}
        configWritePermission="allowed"
      />
    </>
  );
}

it('restaurar una revisión vacía el motivo escrito antes: la auditoría no describe otra acción', async () => {
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true))));
  const user = userEvent.setup();
  renderWithApi(<VistaConRestauracion />);
  await screen.findByLabelText(/Identidad y propósito/i);

  await motivar(user, 'agrego la herramienta de despliegue');
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i))
    .toHaveValue('agrego la herramienta de despliegue');

  await user.click(screen.getByRole('button', { name: 'simular restauración' }));
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toHaveValue('');
  expect(screen.getByRole('button', { name: /Guardar y aplicar perfil/i })).toBeDisabled();
});

it('la recarga de contexto sólo se ofrece cuando hay algo que recargar', async () => {
  server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true))));
  const { unmount } = renderWithApi(<Vista />);
  await screen.findByLabelText(/Identidad y propósito/i);
  expect(screen.queryByRole('button', { name: /Recargar contexto/i })).not.toBeInTheDocument();
  unmount();

  for (const estado of ['pending_session_refresh', 'drifted'] as const) {
    server.use(http.get(RUTA, () => HttpResponse.json(respuesta(true, { runtime_state: estado }))));
    const vista = renderWithApi(<Vista />);
    expect(await screen.findByRole('button', { name: /Recargar contexto/i })).toBeInTheDocument();
    vista.unmount();
  }
});

it('el veredicto limpio de una recarga no tapa la lectura que sí denuncia después', async () => {
  let lecturas = 0;
  server.use(
    http.get(RUTA, () => {
      lecturas += 1;
      const base = respuesta(true, { runtime_state: 'drifted' });
      return HttpResponse.json(lecturas === 1
        ? { ...base, contaminacion: { contaminated: false, findings: [] } }
        : {
          ...base,
          contaminacion: {
            contaminated: true,
            findings: [{
              reason: 'foreign_managed_block', document: 'AGENTS.md',
              path: '/home/kant/.codex/AGENTS.md', owner: 'Miguel/kratos',
            }],
          },
        });
    }),
    http.post(RECARGA, () => HttpResponse.json({
      ok: true, state: 'pending_session_refresh', evidence: 'runtime_verification',
      message: 'el contexto está en disco y verificado',
      tenant_id: 'Steven', alias: 'kant', revision: 4,
      runtime_verification: {
        state: 'current', generation: 'gen-4', container_id: 'ws-kant',
        observed_at: '2026-08-26T00:00:00Z', documents: [],
      },
      documents: [],
      contaminacion: { contaminated: false, findings: [] },
    })),
  );
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await screen.findByRole('button', { name: /Recargar contexto/i });
  expect(screen.queryByText(/contienen algo que no es suyo/i)).not.toBeInTheDocument();

  await user.type(screen.getByLabelText(/Motivo de la recarga/i), 'rehago los ficheros a mano');
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/contienen algo que no es suyo/i)).toBeInTheDocument();
  expect(screen.getByText('Miguel/kratos')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
  expect(screen.getByLabelText(/Motivo de este cambio de perfil/i)).toBeDisabled();
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
