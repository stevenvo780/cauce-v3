import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandQuestions, loadCatalog, parsePlantilla, type Catalog } from '../src/catalog.js';
import { DecisionService, PREFILTER_SCAN } from '../src/decide.js';
import type { AuditRecord } from '../src/audit.js';
import { DecisionError } from '../src/errors.js';
import type { JevCaller } from '../src/jev-client.js';
import { Limits } from '../src/limits.js';
import type { JevQuestions, JsonObject } from '../src/questions.js';

const CATALOGO = fileURLToPath(new URL('../catalogo/', import.meta.url));

interface RecordedCase {
  readonly caso: string;
  readonly plantilla: string;
  readonly modelo: string;
  readonly state: Record<string, unknown>;
  readonly answers: Record<string, unknown>;
  readonly usage: Record<string, number>;
}

const grabado = JSON.parse(readFileSync(new URL('./fixtures/jev-grabado.json', import.meta.url), 'utf8')) as { casos: RecordedCase[] };

/** Expected decision per recorded case and per asking alias (default argos: the stricter fleet policy). */
const ESPERADO: Record<string, readonly [decision: string, valor: string | null, origen?: 'prefiltro']> = {
  '00-ruteo_alias-zeus': ['rutear', 'zeus'],
  '01-ruteo_alias-kant': ['rutear', 'kant'],
  '02-ruteo_alias-jarvis': ['rutear', 'jarvis'],
  '03-ruteo_alias-ninguno/persona': ['avisar_humano', null],
  '04-ruteo_alias-argos': ['rutear', 'argos'],
  '05-triage_urgencia-P3': ['P2', null],
  '06-triage_urgencia-P0': ['P0', null],
  '07-triage_urgencia-P0-seguridad': ['P0', null],
  '08-aprobacion_humana-prod': ['exige_aprobacion', null],
  '09-aprobacion_humana-libre': ['sin_aprobacion', null],
  '10-aprobacion_humana-dinero': ['exige_aprobacion', null, 'prefiltro'],
  '11-aprobacion_humana-adversarial': ['exige_aprobacion', null, 'prefiltro'],
  '12-cabe_en_un_turno-vigilancia': ['no_cabe', 'monitor'],
  '13-cabe_en_un_turno-cabe': ['cabe', null],
  '14-cabe_en_un_turno-recurrente': ['no_cabe', 'cron'],
  '15-aclarar_o_actuar-falta_dato': ['aclarar', null],
  '16-aclarar_o_actuar-ambiguo_caro': ['aclarar', null],
  '17-aclarar_o_actuar-pregunta': ['contestar', null],
  '18-clasificar_fallo-credencial': ['clase_firme', 'credencial_vencida', 'prefiltro'],
  '19-clasificar_fallo-cuota': ['clase_firme', 'cuota_agotada', 'prefiltro'],
  '20-clasificar_fallo-codigo': ['clase_firme', 'codigo'],
  '21-clasificar_fallo-harness': ['clase_firme', 'harness_caido'],
  '22-reintentar_escalar_cerrar-despues': ['reintentar_despues', null],
  '23-reintentar_escalar_cerrar-cerrar': ['cerrar', null],
  '25-elegir_modelo-mecanico': ['asignar', 'mecanico'],
  '26-elegir_modelo-dificil': ['subir_escalon', 'razonamiento_dificil'],
  '27-elegir_modelo-lectura': ['asignar', 'lectura_masiva'],
  '28-respuesta_cumple-parcial': ['incompleta', null],
  '29-respuesta_cumple-sin_evidencia': ['sin_evidencia', null],
  '30-requiere_respuesta-cortesia': ['no_despertar', null],
  '31-requiere_respuesta-pedido': ['turno_normal', null],
  '32-guardia_privacidad_jarvis-fuga': ['bloquear', null],
  '33-guardia_privacidad_jarvis-tecnico': ['permitir', null],
};

/** zeus only asks permission for money and legal matters: the same actions resolve differently. */
const ESPERADO_ZEUS: Record<string, string> = {
  '08-aprobacion_humana-prod': 'sin_aprobacion',
  '09-aprobacion_humana-libre': 'sin_aprobacion',
  '10-aprobacion_humana-dinero': 'exige_aprobacion',
  '11-aprobacion_humana-adversarial': 'sin_aprobacion',
};

class RecordedJev implements JevCaller {
  readonly maxRequests = 1;
  calls = 0;
  asked: JevQuestions[] = [];
  constructor(private readonly recorded: RecordedCase) {}
  async evaluate(_state: unknown, questions: JevQuestions) {
    this.calls += 1;
    this.asked.push(questions);
    return { body: { model: this.recorded.modelo, answers: this.recorded.answers, usage: this.recorded.usage }, requestId: 'req_grabado', requests: 1, billable: 1, ms: 5 };
  }
  async credentialPresent() { return true; }
}

function service(catalog: Catalog, jev: JevCaller, audit: AuditRecord[] = []): DecisionService {
  return new DecisionService({
    catalog, jev, redact: true,
    limits: new Limits({ perMinute: 600, burst: 100, dailyInputTokens: 1_000_000, dailyInputTokensTotal: 10_000_000, concurrency: 4, concurrencyPerAlias: 4 }),
    audit: { write: async (record) => { audit.push(record); } },
    enabledTemplates: new Set(['guardia_privacidad_jarvis']),
  });
}

let catalog: Catalog;
beforeAll(async () => { catalog = await loadCatalog(CATALOGO); });

describe('catálogo versionado', () => {
  it('carga las 11 plantillas con versión semver y el modelo calibrado', () => {
    expect(catalog.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(catalog.calibratedModel).toBe('jev-1.13.0');
    expect([...catalog.plantillas.keys()].sort()).toEqual([
      'aclarar_o_actuar', 'aprobacion_humana', 'cabe_en_un_turno', 'clasificar_fallo', 'elegir_modelo',
      'guardia_privacidad_jarvis', 'reintentar_escalar_cerrar', 'requiere_respuesta', 'respuesta_cumple',
      'ruteo_alias', 'triage_urgencia',
    ]);
    for (const plantilla of catalog.plantillas.values()) expect(plantilla.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('cada caso grabado contra Jev real lleva a la decisión esperada con las reglas del catálogo', async () => {
    const vistos = new Set<string>();
    for (const recorded of grabado.casos) {
      const expected = ESPERADO[recorded.caso];
      expect(expected, recorded.caso).toBeDefined();
      if (expected === undefined) continue;
      const jev = new RecordedJev(recorded);
      const result = await service(catalog, jev).decide({ tenant: 'Steven', alias: 'argos' }, { plantilla: recorded.plantilla, state: recorded.state });
      expect([result.decision, result.valor, result.origen], recorded.caso).toEqual([expected[0], expected[1], expected[2] ?? 'jev']);
      expect(jev.calls, recorded.caso).toBe(expected[2] === 'prefiltro' ? 0 : 1);
      vistos.add(recorded.caso);
    }
    expect(vistos.size).toBe(Object.keys(ESPERADO).length);
  });

  it('la confianza es la de las señales que decidieron, no la de la pregunta más dudosa del fan-out', async () => {
    const esperada: Record<string, number> = {
      '01-ruteo_alias-kant': 0.94, '07-triage_urgencia-P0-seguridad': 0.94, '17-aclarar_o_actuar-pregunta': 0.94,
      '23-reintentar_escalar_cerrar-cerrar': 0.74, '29-respuesta_cumple-sin_evidencia': 0.96, '09-aprobacion_humana-libre': 0.8,
    };
    for (const recorded of grabado.casos) {
      const result = await service(catalog, new RecordedJev(recorded)).decide({ tenant: 'Steven', alias: 'argos' }, { plantilla: recorded.plantilla, state: recorded.state });
      if (recorded.caso in esperada) expect(result.confianza, recorded.caso).toBe(esperada[recorded.caso]);
      if (result.origen === 'jev' && result.caer_a_llm === false) expect(result.confianza, recorded.caso).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('un score poco confiable nunca da una decisión firme', async () => {
    const dudoso = { confidence: 0.05, legend: {} };
    const casos: [plantilla: string, state: JsonObject, respuestas: Record<string, unknown>][] = [
      ['cabe_en_un_turno', { pedido: 'x' }, { tamano: { type: 'score', score: 1.35, probabilities: { 0: 0.45, 1: 0.05, 2: 0.05, 3: 0.45 }, ...dudoso } }],
      ['respuesta_cumple', { pedido: 'p', respuesta: 'r', requisitos: ['a', 'b'] }, {
        cobertura: { type: 'score', score: 3.1, probabilities: { 3: 0.5, 4: 0.3, 1: 0.2 }, ...dudoso }, 'cumple_req::0': { type: 'noul', noul: 0.65 }, 'cumple_req::1': { type: 'noul', noul: 0.65 },
      }],
      ['triage_urgencia', { mensaje: 'x' }, {
        impacto: { type: 'score', score: 1.5, probabilities: { 0: 0.4, 3: 0.4, 1: 0.2 }, ...dudoso }, plazo: { type: 'score', score: 1.2, probabilities: { 0: 0.5, 3: 0.4, 1: 0.1 }, ...dudoso },
      }],
      ['elegir_modelo', { tarea: 'x' }, { dificultad: { type: 'score', score: 2, probabilities: { 0: 0.5, 4: 0.5 }, ...dudoso } }],
    ];
    for (const [plantilla, state, respuestas] of casos) {
      const definicion = catalog.plantillas.get(plantilla);
      if (definicion === undefined) throw new Error(plantilla);
      const { questions } = expandQuestions(definicion, state, undefined);
      const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, respuestas[id] ?? (question.type === 'noul'
        ? { type: 'noul', noul: 0.1 }
        : { type: 'choice', choice: Object.keys(question.criteria as object)[0], confidence: 0.9, probabilities: { [Object.keys(question.criteria as object)[0] ?? '']: 0.95 } })]));
      const fijo = new RecordedJev({ caso: plantilla, plantilla, modelo: 'jev-1.13.0', state, answers, usage: { input_tokens: 1 } });
      const result = await service(catalog, fijo).decide({ tenant: 'Steven', alias: 'argos' }, { plantilla, state });
      expect(result.decision, plantilla).not.toMatch(/^(cabe|partir|cumple|incompleta|P1|P2|P3|extremo)$/u);
      if (plantilla !== 'elegir_modelo') expect(result.caer_a_llm, plantilla).toBe(true);
    }
  });

  it('la política de aprobación sale del alias que pregunta', async () => {
    for (const [caso, decision] of Object.entries(ESPERADO_ZEUS)) {
      const recorded = grabado.casos.find((entry) => entry.caso === caso);
      if (recorded === undefined) throw new Error(caso);
      const result = await service(catalog, new RecordedJev(recorded)).decide({ tenant: 'Steven', alias: 'zeus' }, { plantilla: 'aprobacion_humana', state: recorded.state });
      expect(result.decision, caso).toBe(decision);
    }
  });

  it('el prefiltro de dinero no confunde los parámetros de shell con montos', async () => {
    const recorded = grabado.casos.find((entry) => entry.caso === '09-aprobacion_humana-libre');
    if (recorded === undefined) throw new Error('falta el caso');
    const origen = async (accion: string): Promise<unknown> =>
      (await service(catalog, new RecordedJev(recorded)).decide({ tenant: 'Steven', alias: 'zeus' }, { plantilla: 'aprobacion_humana', state: { accion_propuesta: accion } })).origen;
    const shell = [
      "awk '{print $1}' registro.log", 'echo "$2 ${10}" > salida', 'git log -n 5', "awk '{print $12}' /var/log/cauce/acceso.log | sort | uniq -c",
      'echo "$10 $11" en un script de prueba', "awk '$12 > 100' datos.tsv", "awk '{print $10, $12}' x", "awk '{s+=$12} END {print s}' x",
    ];
    for (const comando of shell) expect(await origen(comando), comando).toBe('jev');
    const montos = ['pagar $20 del dominio', 'renovar por 12 dólares', 'cobrar USD 300', 'subir el plan a $9.99', 'cuesta $1.500 al mes', 'son 1.500 pesos', '$ 300 al mes'];
    for (const monto of montos) expect(await origen(monto), monto).toBe('prefiltro');
  });

  it('los prefiltros de aprobación siguen reconociendo lo destructivo y las rutas de secretos', async () => {
    const recorded = grabado.casos.find((entry) => entry.caso === '09-aprobacion_humana-libre');
    if (recorded === undefined) throw new Error('falta el caso');
    const origen = async (accion: string): Promise<unknown> =>
      (await service(catalog, new RecordedJev(recorded)).decide({ tenant: 'Steven', alias: 'jarvis' }, { plantilla: 'aprobacion_humana', state: { accion_propuesta: accion } })).origen;
    const peligrosas = [
      'rm -rf /srv/datos', 'rm -Rf x', 'rm -fr x', 'git push origin main --force', 'git push -f', 'docker compose -f prod.yaml down -v',
      'DELETE FROM clientes;', 'DROP TABLE x', 'TRUNCATE eventos', 'systemctl --user restart cauce', 'docker volume rm datos',
      'cat /etc/cauce-v3/secrets/x', 'leer zeus.token', 'copiar client.key',
    ];
    for (const accion of peligrosas) expect(await origen(accion), accion).toBe('prefiltro');
    for (const accion of ['rm -r x', 'git push origin main', 'docker compose down', 'docker compose up -d', 'DELETE FROM t WHERE id=1;', 'pnpm test']) {
      expect(await origen(accion), accion).toBe('jev');
    }
  });

  it('ningún prefiltro del catálogo retrocede de forma catastrófica con 64 KiB hostiles', async () => {
    const repetir = (fragmento: string, prefijo = ''): string =>
      (prefijo + fragmento.repeat(Math.ceil(PREFILTER_SCAN / fragmento.length))).slice(0, PREFILTER_SCAN);
    const genericos = ['a', '1.', '1,', '$1', '$12 ', ' ', '\n', 'a-', 'a.', 'eyJ-', 'docker compose down ', 'git push ', 'DELETE FROM a ', '-----BEGIN A '];
    for (const plantilla of catalog.plantillas.values()) {
      for (const [indice, prefiltro] of plantilla.prefilters.entries()) {
        const palabras = [...new Set(prefiltro.patron.source.match(/[A-Za-z_]{2,}/gu) ?? [])];
        const entradas = [
          ...genericos.map((fragmento) => repetir(fragmento)), repetir('r', 'rm -'), repetir('f', 'rm -'),
          ...palabras.flatMap((palabra) => [repetir(`${palabra} `), repetir(`${palabra}-`), repetir(`${palabra}.`), repetir('a', palabra)]),
        ];
        for (const entrada of entradas) {
          const inicio = performance.now();
          prefiltro.patron.test(entrada);
          expect(performance.now() - inicio, `${plantilla.id}.prefiltros[${String(indice)}] ${JSON.stringify(entrada.slice(0, 24))}`).toBeLessThan(250);
        }
      }
    }
    const recorded = grabado.casos.find((entry) => entry.caso === '09-aprobacion_humana-libre');
    if (recorded === undefined) throw new Error('falta el caso');
    const inicio = performance.now();
    await service(catalog, new RecordedJev(recorded)).decide({ tenant: 'Steven', alias: 'jarvis' }, { plantilla: 'aprobacion_humana', state: { accion_propuesta: 'docker compose down '.repeat(3_000) } });
    expect(performance.now() - inicio).toBeLessThan(500);
  });

  it('ruteo_alias restringe candidatos, conserva ninguno y sólo pregunta encaja:: por los ofrecidos', () => {
    const ruteo = catalog.plantillas.get('ruteo_alias');
    if (ruteo === undefined) throw new Error('falta ruteo_alias');
    const state = { pedido: { texto: 'x' } };
    const todo = Object.keys(expandQuestions(ruteo, state, undefined).questions).sort();
    expect(todo).toEqual(['destino', 'encaja::argos', 'encaja::jarvis', 'encaja::kant', 'encaja::socrates', 'encaja::zeus', 'es_para_persona']);
    const restringido = expandQuestions(ruteo, state, { destino: ['zeus', 'kant'] }).questions;
    expect(Object.keys(restringido).sort()).toEqual(['destino', 'encaja::kant', 'encaja::zeus', 'es_para_persona']);
    expect(Object.keys(restringido.destino?.criteria as object)).toEqual(['zeus', 'kant', 'ninguno']);
    const instrucciones = JSON.stringify(restringido['encaja::zeus']?.instructions);
    expect(instrucciones).toContain('Médico de la flota');
    expect(() => expandQuestions(ruteo, state, { destino: ['hades'] })).toThrow(DecisionError);
    expect(() => expandQuestions(ruteo, state, { es_para_persona: ['zeus'] })).toThrow(/no admite restricción/u);
  });

  it('respuesta_cumple instancia un noul por requisito y rechaza listas fuera de rango', () => {
    const plantilla = catalog.plantillas.get('respuesta_cumple');
    if (plantilla === undefined) throw new Error('falta respuesta_cumple');
    const { questions } = expandQuestions(plantilla, { pedido: 'p', respuesta: 'r', requisitos: ['a', 'b', 'c'] }, undefined);
    expect(Object.keys(questions).filter((id) => id.startsWith('cumple_req::'))).toEqual(['cumple_req::0', 'cumple_req::1', 'cumple_req::2']);
    expect(JSON.stringify(questions['cumple_req::2']?.instructions)).toContain('requisitos[2]');
    expect(() => expandQuestions(plantilla, { pedido: 'p', respuesta: 'r', requisitos: [] }, undefined)).toThrow(/1 a 20/u);
    expect(() => expandQuestions(plantilla, { pedido: 'p', respuesta: 'r' }, undefined)).toThrow(DecisionError);
  });

  it('una plantilla nueva sólo necesita su fichero, y el cargador rechaza referencias rotas', () => {
    const minima = {
      id: 'nueva', version: '1.0.0', nombre: 'n', cuando_usar: 'c', state: {},
      questions: { ok: { type: 'noul', instructions: '¿`x` está bien?' } },
      reglas: [{ si: { p: 'ok', '>=': 0.8 }, entonces: { decision: 'si', motivo: 'm' } }],
      sino: { decision: 'llm', motivo: 'm', llm: true }, si_falla: { decision: 'llm', motivo: 'm', llm: true },
    };
    expect(parsePlantilla(minima, 'nueva.json').id).toBe('nueva');
    expect(() => parsePlantilla({ ...minima, reglas: [{ si: { p: 'no_existe', '>=': 0.5 }, entonces: { decision: 'x', motivo: 'm' } }] }, 'f')).toThrow(/inexistente/u);
    expect(() => parsePlantilla({ ...minima, si_falla: { decision: '{eleccion:ok}', motivo: 'm' } }, 'f')).toThrow(/si_falla/u);
    expect(() => parsePlantilla({ ...minima, prefiltros: [{ campos: ['x'], patron: '(', entonces: { decision: 'x', motivo: 'm' } }] }, 'f')).toThrow(/patron/u);
    expect(() => parsePlantilla({ ...minima, extra: 1 }, 'f')).toThrow(/desconocido/u);
    expect(() => parsePlantilla({ ...minima, reglas: [{ si: { max: ['ok'] }, entonces: { decision: 'x', motivo: 'm' } }] }, 'f')).toThrow(/comparador/u);
  });

  it('una plantilla que exige habilitación queda apagada y responde con su respaldo', async () => {
    const recorded = grabado.casos.find((entry) => entry.plantilla === 'guardia_privacidad_jarvis');
    if (recorded === undefined) throw new Error('falta el caso');
    const jev = new RecordedJev(recorded);
    const apagado = new DecisionService({
      catalog, jev, redact: true,
      limits: new Limits({ perMinute: 60, burst: 5, dailyInputTokens: 10_000, dailyInputTokensTotal: 10_000, concurrency: 1, concurrencyPerAlias: 1 }),
      audit: { write: async () => undefined },
    });
    const error = await apagado.decide({ tenant: 'Steven', alias: 'jarvis' }, { plantilla: 'guardia_privacidad_jarvis', state: recorded.state }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).toBody()).toMatchObject({ error: 'plantilla_deshabilitada', respaldo: { decision: 'bloquear' } });
    expect(jev.calls).toBe(0);
    const listado = apagado.listing().plantillas as { id: string; habilitada: boolean }[];
    expect(listado.find((entry) => entry.id === 'guardia_privacidad_jarvis')?.habilitada).toBe(false);
    expect(listado.find((entry) => entry.id === 'ruteo_alias')?.habilitada).toBe(true);
  });
});
