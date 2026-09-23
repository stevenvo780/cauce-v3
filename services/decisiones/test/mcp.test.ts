import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDecisionesMcpServer, decisionesForwarder, EmissionRuntime, RESPALDO_SIN_SERVICIO } from '@cauce/adapter-sdk';
import { loadCatalog } from '../src/catalog.js';
import { defaultAnswers } from './support/fake-jev.js';
import { startHarness, type Harness } from './support/servicio.js';

/**
 * The whole path an agent uses: MCP stdio server (no credential) → the alias's 0600 socket →
 * adapter forwarder with the alias's mTLS certificate → decisions service → Jev (fake).
 */
let h: Harness;
let directory: string;
let runtime: EmissionRuntime;
let client: Client;

async function connect(socketPath: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createDecisionesMcpServer(socketPath).connect(serverSide);
  const connected = new Client({ name: 'prueba', version: '1.0.0' });
  await connected.connect(clientSide);
  return connected;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
}

/** A `cauce_status` call goes through the emission queue that a decision must never occupy. */
function statusCall(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const outgoing = request({ socketPath, path: '/tool', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume();
      response.on('end', () => { resolve(Date.now() - started); });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ name: 'cauce_status', arguments: {}, turn_token: null }));
  });
}

beforeAll(async () => {
  h = await startHarness();
  directory = await mkdtemp(join(tmpdir(), 'cauce-decisiones-alias-'));
  const zeus = h.pki.client('zeus');
  runtime = new EmissionRuntime(directory, 'instancia-prueba', async () => ({}), decisionesForwarder(
    `https://127.0.0.1:${String(h.service.port)}`,
    { certFile: zeus.cert, keyFile: zeus.key, caFile: h.pki.caCert },
  ));
  await runtime.listen();
  client = await connect(runtime.socketPath);
});

afterAll(async () => {
  await client.close();
  await runtime.close();
  await h.stop();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  h.jev.seen.length = 0;
  h.jev.answers((seen) => defaultAnswers(seen.body.questions));
});

describe('MCP cauce-decisiones a través del adaptador', () => {
  it('expone exactamente las tres herramientas de decisión', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['decidir', 'decidir_plantilla', 'listar_plantillas']);
  });

  it('lista plantillas y decide con una, con la identidad del certificado del alias', async () => {
    const listing = text(await client.callTool({ name: 'listar_plantillas', arguments: {} }));
    expect((listing.plantillas as unknown[]).length).toBe(11);
    h.jev.answers(() => ({ solo_cortesia: { type: 'noul', noul: 0.95 }, contiene_pedido: { type: 'noul', noul: 0.05 } }));
    const result = await client.callTool({ name: 'decidir_plantilla', arguments: { plantilla: 'requiere_respuesta', state: { mensaje: '¡Gracias! Recibido.', remitente: 'hegel' } } });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatchObject({ decision: 'no_despertar', caer_a_llm: false, confianza: 0.9 });
    const audit = h.jev.seen.at(-1);
    expect(audit?.body.state).toEqual({ mensaje: '¡Gracias! Recibido.', remitente: 'hegel' });
  });

  it('pasa restricciones de candidatos y preguntas libres', async () => {
    const routed = text(await client.callTool({ name: 'decidir_plantilla', arguments: { plantilla: 'ruteo_alias', state: { pedido: { texto: 'se cayó mi adaptador' } }, restringir: { destino: ['zeus', 'kant'] } } }));
    expect(Object.keys(h.jev.seen.at(-1)?.body.questions ?? {}).sort()).toEqual(['destino', 'encaja::kant', 'encaja::zeus', 'es_para_persona']);
    expect(routed).toMatchObject({ plantilla: 'ruteo_alias' });
    const free = await client.callTool({ name: 'decidir', arguments: { state: 'x', questions: { ok: { type: 'noul', instructions: '¿`x` está bien?' } } } });
    expect(text(free)).toMatchObject({ respuestas: { ok: { p: 0.9 } }, caer_a_llm: false });
  });

  it('el modelo no puede elegir identidad ni rutas: el adaptador rechaza argumentos extra', async () => {
    const forged = await client.callTool({ name: 'decidir_plantilla', arguments: { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'x' }, alias: 'zeus' } });
    expect(forged.isError).toBe(true);
    expect(text(forged)).toMatchObject({ error: 'solicitud_invalida' });
    const traversal = await client.callTool({ name: 'listar_plantillas', arguments: { plantilla: '../health' } });
    expect(traversal.isError).toBe(true);
    expect(h.jev.seen).toHaveLength(0);
  });

  it('un fallo de Jev llega al modelo como error con el respaldo que debe aplicar', async () => {
    h.jev.respond(() => ({ status: 529, body: {} }));
    const result = await client.callTool({ name: 'decidir_plantilla', arguments: { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'reiniciar el servicio' } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ error: 'jev_sobrecargado', respaldo: { decision: 'exige_aprobacion' } });
  });

  it('una decisión lenta no frena el socket de emisión del turno', async () => {
    h.jev.respond((seen) => ({ delayMs: 800, body: { model: 'jev-1.13.0', answers: defaultAnswers(seen.body.questions), usage: { input_tokens: 1, output_tokens: 1 } } }));
    const slow = client.callTool({ name: 'decidir', arguments: { state: 'x', questions: { ok: { type: 'noul', instructions: 'x' } } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await statusCall(runtime.socketPath)).toBeLessThan(400);
    expect((await slow).isError).toBeUndefined();
  });

  it('sin servicio configurado, inalcanzable o sin adaptador, el modelo recibe igual un respaldo que falla cerrado', async () => {
    const aprobar = { name: 'decidir_plantilla', arguments: { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'DROP TABLE clientes en prod' } } };
    const bare = await mkdtemp(join(tmpdir(), 'cauce-decisiones-sin-'));
    const unconfigured = new EmissionRuntime(bare, 'sin-decisiones', async () => ({}));
    const zeus = h.pki.client('zeus');
    const unreachable = new EmissionRuntime(join(bare, 'caido'), 'caido', async () => ({}), decisionesForwarder('https://127.0.0.1:9', { certFile: zeus.cert, keyFile: zeus.key, caFile: h.pki.caCert }));
    await unconfigured.listen();
    await unreachable.listen();
    const orphan = await connect(unconfigured.socketPath);
    const lost = await connect(unreachable.socketPath);
    const noAdapter = await connect(join(bare, 'no-existe.sock'));
    try {
      const libre = await orphan.callTool({ name: 'decidir', arguments: { state: 'x', questions: { ok: { type: 'noul', instructions: 'x' } } } });
      expect(libre.isError).toBe(true);
      expect(text(libre)).toMatchObject({ error: 'decisiones_no_configurado', respaldo: { decision: 'llm', caer_a_llm: true } });
      expect(text(await orphan.callTool(aprobar))).toMatchObject({ error: 'decisiones_no_configurado', respaldo: { decision: 'exige_aprobacion', caer_a_llm: false } });
      expect(text(await lost.callTool(aprobar))).toMatchObject({ error: 'decisiones_inalcanzable', respaldo: { decision: 'exige_aprobacion' } });
      const caido = await noAdapter.callTool(aprobar);
      expect(caido.isError).toBe(true);
      expect(text(caido)).toMatchObject({ error: 'adaptador_no_responde', respaldo: { decision: 'exige_aprobacion' } });
      expect(text(await lost.callTool({ name: 'decidir_plantilla', arguments: { plantilla: 'guardia_privacidad_jarvis', state: { texto: 'x' } } }))).toMatchObject({ respaldo: { decision: 'bloquear' } });
    } finally {
      await Promise.all([orphan.close(), lost.close(), noAdapter.close()]);
      await Promise.all([unconfigured.close(), unreachable.close()]);
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('el respaldo del adaptador para las plantillas de seguridad es el si_falla del catálogo', async () => {
    const catalogo = await loadCatalog(fileURLToPath(new URL('../catalogo/', import.meta.url)));
    const cerradas = [...catalogo.plantillas.values()].filter((plantilla) => !plantilla.siFalla.llm).map((plantilla) => plantilla.id);
    expect(cerradas).toEqual(expect.arrayContaining(Object.keys(RESPALDO_SIN_SERVICIO)));
    for (const [id, respaldo] of Object.entries(RESPALDO_SIN_SERVICIO)) {
      const plantilla = catalogo.plantillas.get(id);
      expect([respaldo.decision, respaldo.caer_a_llm], id).toEqual([plantilla?.siFalla.decision, plantilla?.siFalla.llm]);
    }
  });
});
