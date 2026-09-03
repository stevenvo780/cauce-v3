import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AvisoDeContaminacion, RecargaDeContexto } from './RecargaDeContexto';
import type { ContaminacionDeContexto } from './perfil';

const RUTA = 'http://localhost/v3/console/tenants/Steven/agents/kant/context/reload';
const SHA_VIEJO = 'a'.repeat(64);
const SHA_NUEVO = 'b'.repeat(64);
const MOTIVO = 'rehago los ficheros a mano';

const RECARGA_HECHA = {
  ok: true,
  state: 'pending_session_refresh',
  evidence: 'runtime_verification',
  message: 'el contexto está en disco y verificado',
  tenant_id: 'Steven',
  alias: 'kant',
  revision: 4,
  runtime_verification: {
    state: 'current', generation: 'gen-4', container_id: 'ws-kant',
    observed_at: '2026-08-26T00:00:00Z', documents: [],
  },
  documents: [{
    name: 'CLAUDE.md', path: '/home/stev/.claude/CLAUDE.md',
    sha_before: SHA_VIEJO, sha_after: SHA_NUEVO, bytes: 1024,
  }],
  contaminacion: { contaminated: false, findings: [] },
};

function Vista({ permitida = true, enCuarentena = false }: {
  permitida?: boolean; enCuarentena?: boolean;
}) {
  const [veredicto, setVeredicto] = useState<ContaminacionDeContexto>();
  const [recargas, setRecargas] = useState(0);
  return (
    <>
      <RecargaDeContexto
        tenantId="Steven"
        alias="kant"
        permitida={permitida}
        enCuarentena={enCuarentena || veredicto?.contaminated === true}
        onVeredicto={setVeredicto}
        onRecargado={() => { setRecargas((previas) => previas + 1); }}
      />
      <p>relecturas: {recargas}</p>
      <p>veredicto: {veredicto === undefined ? 'sin dato' : String(veredicto.contaminated)}</p>
      {veredicto?.contaminated === true
        ? <AvisoDeContaminacion contaminacion={veredicto} />
        : null}
    </>
  );
}

async function motivar(user: ReturnType<typeof userEvent.setup>, texto = MOTIVO) {
  await user.type(screen.getByLabelText(/Motivo de la recarga/i), texto);
}

it('sin un motivo escrito a mano no se recarga, y el POST no sale', async () => {
  let posts = 0;
  server.use(http.post(RUTA, () => {
    posts += 1;
    return HttpResponse.json(RECARGA_HECHA);
  }));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  expect(screen.getByLabelText(/Motivo de la recarga/i)).toHaveValue('');
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();

  await motivar(user, 'corto');
  expect(screen.getByText(/necesita al menos 8 caracteres/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();

  await motivar(user, ' pero ya no lo es');
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeEnabled();
  expect(posts).toBe(0);
});

it('una recarga acreditada dice estado, evidencia y las huellas de cada fichero', async () => {
  let cuerpo: Record<string, unknown> | undefined;
  server.use(http.post(RUTA, async ({ request }) => {
    cuerpo = await request.json() as Record<string, unknown>;
    return HttpResponse.json(RECARGA_HECHA);
  }));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user, `  ${MOTIVO}  `);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  await waitFor(() => { expect(cuerpo).toBeDefined(); });
  expect(cuerpo).toEqual({ reason: MOTIVO });
  expect(await screen.findByText(/pending_session_refresh/)).toBeInTheDocument();
  expect(screen.getByText(/runtime_verification/)).toBeInTheDocument();
  expect(screen.getByText(/aaaaaaaaaaaa….*bbbbbbbbbbbb….*1024 bytes/)).toBeInTheDocument();
  expect(screen.getByText(/relecturas: 1/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Motivo de la recarga/i)).toHaveValue('');
});

it('la copia dice que reescribe y vuelve a medir, y que NO reinicia la TUI', async () => {
  renderWithApi(<Vista />);
  const ayuda = screen.getByText(/Recargar reescribe y vuelve a medir/i);
  expect(ayuda).toHaveTextContent(/NO reinicia la TUI/);
  expect(ayuda).toHaveTextContent(/ACK de adopción/);
});

it('un 409 de entrega en vuelo nombra las entregas que hay ahora mismo', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({
    error: 'delivery_in_flight',
    message: 'hay una entrega en vuelo para este alias.',
    deliveries: ['dlv-71', { delivery_id: 'dlv-72' }],
  }, { status: 409 })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  const aviso = await screen.findByRole('alert');
  expect(aviso).toHaveTextContent(/Hay una entrega en vuelo/i);
  expect(aviso).toHaveTextContent(/En vuelo ahora: dlv-71, dlv-72\./);
});

it('un 409 de cuarentena entrega el veredicto al padre y no se presenta como recargado', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({
    error: 'context_contaminated',
    message: 'los ficheros de gobierno de este alias contienen algo que no es suyo',
    contaminacion: {
      contaminated: true,
      findings: [{
        reason: 'foreign_managed_block', document: 'CLAUDE.md',
        path: '/home/stev/.claude/CLAUDE.md', owner: 'Miguel/kratos',
      }],
    },
  }, { status: 409 })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/Contexto en cuarentena/i)).toBeInTheDocument();
  expect(screen.getByText(/veredicto: true/)).toBeInTheDocument();
  expect(screen.getByText(/relecturas: 0/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
});

it('una sesión sin persona detrás lo dice en castellano y conserva el motivo', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({
    error: 'forbidden',
    reason: 'writable_requires_attribution',
    message: 'recargar el contexto de un alias exige una persona con nombre',
  }, { status: 403 })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/no acredita a la persona que escribe/i)).toBeInTheDocument();
  expect(screen.getByText(/identidad de operador/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Motivo de la recarga/i)).toHaveValue(MOTIVO);
});

it('un 2xx que no acredita el lote no se pinta como recarga hecha', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({ ok: true, state: 'applied' })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/no acreditó la recarga/i)).toBeInTheDocument();
  expect(screen.getByText(/relecturas: 0/)).toBeInTheDocument();
});

it('un 200 cuyo veredicto se contradice a sí mismo deja el contexto en cuarentena', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({
    ...RECARGA_HECHA,
    contaminacion: {
      contaminated: false,
      findings: [{
        reason: 'foreign_managed_block', document: 'CLAUDE.md',
        path: '/home/stev/.claude/CLAUDE.md', owner: 'Miguel/kratos',
      }],
    },
  })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/veredicto: true/)).toBeInTheDocument();
  expect(screen.getByText(/no acreditó la recarga/i)).toBeInTheDocument();
  expect(screen.getByText(/relecturas: 0/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
});

it('CONTROL NEGATIVO: un 200 con hallazgos que no son lista ensucia y sigue pintando', async () => {
  server.use(http.post(RUTA, () => HttpResponse.json({
    ...RECARGA_HECHA,
    contaminacion: { contaminated: true, findings: 'CLAUDE.md' },
  })));
  const user = userEvent.setup();
  renderWithApi(<Vista />);

  await motivar(user);
  await user.click(screen.getByRole('button', { name: /Recargar contexto/i }));

  expect(await screen.findByText(/veredicto: true/)).toBeInTheDocument();
  const cuarentena = await screen.findByText(/contienen algo que no es suyo/i);
  expect(cuarentena).toBeInTheDocument();
  expect(screen.getByText(/no se puede leer no se presenta como limpio/i)).toBeInTheDocument();
  expect(screen.getByText(/relecturas: 0/)).toBeInTheDocument();
});

it('CONTROL NEGATIVO: en cuarentena o sin permiso no hay campo ni botón que se puedan usar', async () => {
  let posts = 0;
  server.use(http.post(RUTA, () => {
    posts += 1;
    return HttpResponse.json(RECARGA_HECHA);
  }));
  const { unmount } = renderWithApi(<Vista enCuarentena />);
  expect(screen.getByLabelText(/Motivo de la recarga/i)).toBeDisabled();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
  unmount();

  renderWithApi(<Vista permitida={false} />);
  expect(screen.getByLabelText(/Motivo de la recarga/i)).toBeDisabled();
  expect(screen.getByRole('button', { name: /Recargar contexto/i })).toBeDisabled();
  expect(posts).toBe(0);
});
