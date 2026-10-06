import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { abrirContexto } from './context-test-utils';
import { RUTA_PERFIL, perfilAplicado } from './perfil-fixtures';

const DOCUMENTS = 'http://localhost/v3/console/tenants/Steven/agents/kant/documents';
const ORIGINAL_SHA = 'a'.repeat(64);
const UPDATED_SHA = 'b'.repeat(64);
const ORIGINAL_PATH = '/home/stev/.claude/CLAUDE.md';

function serveManual() {
  const source = { harness: 'claude', path: ORIGINAL_PATH, sha: ORIGINAL_SHA, content: 'manual original' };
  const writes: unknown[] = [];
  const contentReads: string[] = [];
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado(4, {
      harness: source.harness, runtime_verification: null, runtime_adoption: null, ficheros: [],
    }))),
    http.get(DOCUMENTS, () => HttpResponse.json({
      facts_source: 'measured', harness: source.harness,
      items: [{ kind: 'directive', label: 'Manual medido', path: source.path,
        format: 'markdown', readable: true, editable: true }],
    })),
    http.get(`${DOCUMENTS}/directive/content`, () => {
      contentReads.push(source.sha);
      return HttpResponse.json({
        tenant_id: 'Steven', alias: 'kant', kind: 'directive', path: source.path,
        format: 'markdown', exists: true, content: source.content, sha: source.sha,
        bytes: new TextEncoder().encode(source.content).byteLength,
        editable: true, truncated: false, projected: false,
      });
    }),
    http.put(`${DOCUMENTS}/directive/content`, async ({ request }) => {
      const body = await request.json() as { content: string; expected_sha: string };
      writes.push(body);
      return HttpResponse.json({
        ok: true, state: 'written_pending_session', evidence: 'probe_write_ack',
        path: source.path, sha: 'c'.repeat(64), bytes: new TextEncoder().encode(body.content).byteLength,
      });
    }),
  );
  return { source, writes, contentReads };
}

async function editManual() {
  const { user } = await abrirContexto('ficheros');
  await user.click(await screen.findByText('Manual medido'));
  await user.type(await screen.findByLabelText('Contenido de Manual medido'), ' con notas locales');
  return user;
}

it.each([
  ['codex', '/home/dev/.codex/AGENTS.md'],
  ['muse', '/workspace/muse/AGENTS.md'],
  ['openclaw', '/home/claw/workspace/AGENTS.md'],
  ['hermes', '/workspace/hermes/AGENTS.md'],
])('retains the manual draft but blocks its old target after measuring %s', async (harness, path) => {
  const { source, writes, contentReads } = serveManual();
  const user = await editManual();
  source.harness = harness;
  source.path = path;
  source.content = 'manual de otro arnés';
  source.sha = UPDATED_SHA;

  await user.click(screen.getByRole('button', { name: 'Actualizar estado del contexto' }));
  await user.click(await screen.findByText('Manual medido'));
  expect(await screen.findByLabelText('Contenido de Manual medido')).toHaveValue('manual original con notas locales');
  expect(screen.getByText(/El destino del manual cambió/)).toHaveAttribute('role', 'alert');
  await user.type(screen.getByLabelText(/Motivo del guardado/i), 'conservar mis notas locales');
  expect(screen.getByRole('button', { name: /^Guardar$/ })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /^Guardar$/ }));
  expect(writes).toEqual([]);

  source.content = 'manual releído al descartar';
  source.sha = 'd'.repeat(64);
  const readsBeforeDiscard = contentReads.length;
  await user.click(screen.getByRole('button', { name: 'Descartar y releer' }));
  await waitFor(() => { expect(contentReads).toHaveLength(readsBeforeDiscard + 1); });
  expect(contentReads.at(-1)).toBe(source.sha);
  await waitFor(() => { expect(screen.getByLabelText('Contenido de Manual medido')).toHaveValue(source.content); });
  expect(screen.queryByText(/El destino del manual cambió/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Borrador sin guardar\. Cerrar este panel/)).not.toBeInTheDocument();
  expect(writes).toEqual([]);
  await user.type(screen.getByLabelText('Contenido de Manual medido'), ' con notas nuevas');
  expect(screen.getByRole('button', { name: /^Guardar$/ })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: /^Guardar$/ }));
  await screen.findByText(/Sesión sin adoptar todavía/);
  expect(writes).toEqual([{
    content: 'manual releído al descartar con notas nuevas', expected_sha: 'd'.repeat(64),
    reason: 'conservar mis notas locales',
  }]);
});

it('lists OpenClaw memory as unreadable and never offers to read or write it', async () => {
  const reason = 'La memoria viva pertenece al arnés; no se sirve ni se edita desde la consola.';
  let memoryReads = 0;
  let writes = 0;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado(4, {
      harness: 'openclaw', runtime_verification: null, runtime_adoption: null, ficheros: [],
    }))),
    http.get(DOCUMENTS, () => HttpResponse.json({
      facts_source: 'measured', harness: 'openclaw',
      items: [{ kind: 'memory', category: 'memory', label: 'Memoria del arnés',
        path: '/home/claw/workspace/MEMORY.md', format: 'markdown',
        readable: false, editable: false, reason }],
    })),
    http.get(`${DOCUMENTS}/memory/content`, () => { memoryReads += 1; return HttpResponse.json({}); }),
    http.put(`${DOCUMENTS}/:kind/content`, () => { writes += 1; return HttpResponse.json({}); }),
  );
  const { user } = await abrirContexto('ficheros');
  const memory = (await screen.findByText('Memoria del arnés')).closest('li');
  expect(memory).not.toBeNull();
  expect(within(memory as HTMLElement).getByText(reason)).toBeInTheDocument();
  expect(within(memory as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Guardar$/ })).not.toBeInTheDocument();
  await user.click(screen.getByText('Memoria del arnés'));
  expect(memoryReads).toBe(0);
  expect(writes).toBe(0);
});
