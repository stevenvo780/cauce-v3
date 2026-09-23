import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { defaultAnswers } from './support/fake-jev.js';
import { startHarness, TEST_KEY, type Harness } from './support/servicio.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    identities: (pki) => [
      { fingerprint: pki.client('zeus').fingerprint, alias: 'zeus' },
      { fingerprint: pki.client('jarvis').fingerprint, alias: 'jarvis' },
      { fingerprint: pki.client('consola').fingerprint, alias: 'kant', roles: ['operator'] },
      { fingerprint: pki.client('sinruta').fingerprint, alias: 'socrates', permissions: ['read'] },
      { fingerprint: pki.client('vencido').fingerprint, alias: 'tales', expiresAt: '2020-01-01T00:00:00Z' },
    ],
  });
});
afterAll(async () => { await h.stop(); });
beforeEach(() => {
  h.jev.seen.length = 0;
  h.jev.answers((request) => defaultAnswers(request.body.questions));
});

const zeus = () => h.pki.client('zeus');
const jarvis = () => h.pki.client('jarvis');

function auditLines(): Record<string, unknown>[] {
  return readFileSync(h.auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('servicio de decisiones sobre mTLS', () => {
  it('rechaza en el handshake a quien no trae certificado o lo trae de otra CA', async () => {
    await expect(h.call(undefined, 'GET', '/health')).rejects.toThrow();
    await expect(h.call(h.pki.foreignClient(), 'GET', '/health')).rejects.toThrow();
  });

  it('la identidad sale del certificado: no aprovisionado, vencido, sin rol o sin route no pasan', async () => {
    expect((await h.call(h.pki.client('intruso'), 'GET', '/v1/plantillas')).body).toMatchObject({ error: 'no_autenticado' });
    expect((await h.call(h.pki.client('vencido'), 'GET', '/v1/plantillas')).status).toBe(401);
    expect((await h.call(h.pki.client('consola'), 'GET', '/v1/plantillas')).status).toBe(403);
    expect((await h.call(h.pki.client('sinruta'), 'GET', '/v1/plantillas')).status).toBe(403);
    const forged = await h.call(zeus(), 'POST', '/v1/decidir', { alias: 'argos', state: 'x', questions: { a: { type: 'noul', instructions: 'x' } } });
    expect(forged.status).toBe(400);
    expect(forged.body.mensaje).toContain('certificado');
  });

  it('health informa catálogo y credencial sin exponerla', async () => {
    const health = await h.call(zeus(), 'GET', '/health');
    expect(health.body).toMatchObject({ ok: true, catalogo: { plantillas: 11 }, jev: { credencial: 'presente' } });
    expect(JSON.stringify(health.body)).not.toContain(TEST_KEY);
    const internal = await fetch(`http://127.0.0.1:${String((h.service.health.address() as AddressInfo).port)}/health/ready`);
    expect(internal.status).toBe(200);
  });

  it('lista plantillas y da la definición completa de una', async () => {
    const listing = await h.call(zeus(), 'GET', '/v1/plantillas');
    const plantillas = listing.body.plantillas as { id: string; decisiones: string[]; habilitada: boolean }[];
    expect(plantillas).toHaveLength(11);
    expect(plantillas.find((entry) => entry.id === 'reintentar_escalar_cerrar')?.decisiones).toEqual(
      expect.arrayContaining(['escalar_zeus', 'cerrar', 'reintentar_ya', 'reintentar_despues']),
    );
    expect(plantillas.find((entry) => entry.id === 'guardia_privacidad_jarvis')?.habilitada).toBe(false);
    const detail = await h.call(zeus(), 'GET', '/v1/plantillas/ruteo_alias');
    expect(detail.body).toMatchObject({ plantilla: { id: 'ruteo_alias', version: '1.0.0' } });
    expect((await h.call(zeus(), 'GET', '/v1/plantillas/no_existe')).status).toBe(404);
  });

  it('decide con preguntas libres y marca caer_a_llm cuando una respuesta queda bajo el umbral', async () => {
    const questions = {
      urgente: { type: 'noul', instructions: '¿`mensaje` pide atención inmediata?' },
      equipo: { type: 'choice', instructions: '¿Qué equipo lo atiende?', criteria: { infra: 'servidores', producto: 'código' } },
    };
    const firm = await h.call(zeus(), 'POST', '/v1/decidir', { state: { mensaje: 'se cayó el VPS' }, questions });
    expect(firm.status).toBe(200);
    expect(firm.body).toMatchObject({ caer_a_llm: false, respuestas: { urgente: { respuesta: 'si', firme: true }, equipo: { eleccion: 'infra' } } });
    h.jev.answers(() => ({ urgente: { type: 'noul', noul: 0.55 }, equipo: { type: 'choice', choice: 'infra', confidence: 0.2, probabilities: { infra: 0.55, producto: 0.45 } } }));
    const doubtful = await h.call(zeus(), 'POST', '/v1/decidir', { state: 'x', questions, umbrales: { confianza: 0.5 } });
    expect(doubtful.body).toMatchObject({ caer_a_llm: true, inciertas: ['urgente', 'equipo'] });
    const bad = await h.call(zeus(), 'POST', '/v1/decidir', { state: 'x', questions: { a: { type: 'choice', instructions: 'x', criteria: { sola: 'y' } } } });
    expect(bad.status).toBe(400);
    expect(h.jev.seen).toHaveLength(2);
  });

  it('aplica la política de aprobación del alias del certificado y enmascara secretos antes de salir', async () => {
    h.jev.answers((request) => ({ ...defaultAnswers(request.body.questions), ...Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: 'noul', noul: id === 'toca_produccion' ? 0.98 : 0.03 }])) }));
    const state = { accion_propuesta: 'docker compose up -d gateway con Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', entorno: 'vpstn es producción' };
    const asZeus = await h.call(zeus(), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state });
    const asJarvis = await h.call(jarvis(), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state });
    expect(asZeus.body).toMatchObject({ decision: 'sin_aprobacion', origen: 'jev', caer_a_llm: false });
    expect(asJarvis.body).toMatchObject({ decision: 'exige_aprobacion', origen: 'jev' });
    expect(asJarvis.body.redacciones).toBeGreaterThan(0);
    const sent = JSON.stringify(h.jev.seen.map((seen) => seen.body.state));
    expect(sent).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(sent).toContain('docker compose up -d gateway');
  });

  it('un prefiltro determinista decide sin llamar a Jev', async () => {
    const result = await h.call(jarvis(), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'rm -rf /datos/viejo' } });
    expect(result.body).toMatchObject({ decision: 'exige_aprobacion', origen: 'prefiltro' });
    expect(h.jev.seen).toHaveLength(0);
  });

  it('si Jev cae, responde el error tipado con el respaldo de la plantilla', async () => {
    h.jev.respond(() => ({ status: 529, body: { detail: { error_type: 'system_overloaded' } } }));
    const closed = await h.call(jarvis(), 'POST', '/v1/decidir', { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'reiniciar algo' } });
    expect(closed.status).toBe(503);
    expect(closed.body).toMatchObject({ error: 'jev_sobrecargado', respaldo: { decision: 'exige_aprobacion', caer_a_llm: false } });
    const open = await h.call(zeus(), 'POST', '/v1/decidir', { plantilla: 'requiere_respuesta', state: { mensaje: 'gracias' } });
    expect(open.body).toMatchObject({ error: 'jev_sobrecargado', respaldo: { decision: 'turno_normal', caer_a_llm: true } });
    h.jev.respond(() => ({ status: 401, body: {} }));
    const key = await h.call(zeus(), 'POST', '/v1/decidir', { state: 'x', questions: { a: { type: 'noul', instructions: 'x' } } });
    expect(key.body).toMatchObject({ error: 'jev_credencial_rechazada', respaldo: { decision: 'llm' } });
    expect(JSON.stringify(key.body)).not.toContain(TEST_KEY);
  });

  it('la auditoría JSONL guarda alias, preguntas, latencia y certeza, nunca el state ni la clave', async () => {
    const lines = auditLines();
    expect(lines.length).toBeGreaterThan(5);
    const text = readFileSync(h.auditFile, 'utf8');
    for (const forbidden of [TEST_KEY, 'docker compose', 'rm -rf', 'se cayó el VPS', 'abcdefghijklmnopqrstuvwxyz']) expect(text).not.toContain(forbidden);
    const decided = lines.find((line) => line.plantilla === 'aprobacion_humana' && line.origen === 'jev' && line.alias === 'jarvis');
    expect(decided).toMatchObject({ tenant: 'Steven', decision: 'exige_aprobacion', estado: 'ok', usage: { input_tokens: 875 } });
    expect(decided?.state_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decided?.state_bytes).toBeGreaterThan(0);
    expect(decided?.preguntas).toEqual(expect.arrayContaining([{ id: 'toca_produccion', tipo: 'noul' }]));
    expect(lines.some((line) => line.origen === 'fallo' && line.estado === 'jev_sobrecargado')).toBe(true);
  });
});

describe('límites por alias', () => {
  it('responde 429 con retry-after cuando un alias agota su ráfaga, sin afectar a otro', async () => {
    const limited = await startHarness({
      limits: { burst: 2, perMinute: 1 },
      identities: (pki) => [
        { fingerprint: pki.client('zeus').fingerprint, alias: 'zeus' },
        { fingerprint: pki.client('jarvis').fingerprint, alias: 'jarvis' },
      ],
      config: { allowedAliases: new Set(['zeus']) },
    });
    try {
      const body = { state: 'x', questions: { a: { type: 'noul', instructions: 'x' } } };
      const client = limited.pki.client('zeus');
      expect((await limited.call(client, 'POST', '/v1/decidir', body)).status).toBe(200);
      expect((await limited.call(client, 'POST', '/v1/decidir', body)).status).toBe(200);
      const third = await limited.call(client, 'POST', '/v1/decidir', body);
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ error: 'limite_excedido', respaldo: { decision: 'llm' } });
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      const pilot = await limited.call(limited.pki.client('jarvis'), 'POST', '/v1/decidir', body);
      expect(pilot.status).toBe(403);
    } finally { await limited.stop(); }
  });
});
