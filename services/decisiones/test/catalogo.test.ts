import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandQuestions, loadCatalog, parsePlantilla, type Catalog } from '../src/catalog.js';
import { DecisionService } from '../src/decide.js';
import type { AuditRecord } from '../src/audit.js';
import { DecisionError } from '../src/errors.js';
import type { JevCaller } from '../src/jev-client.js';
import { Limits } from '../src/limits.js';
import type { JevQuestions } from '../src/questions.js';

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
  calls = 0;
  asked: JevQuestions[] = [];
  constructor(private readonly recorded: RecordedCase) {}
  async evaluate(_state: unknown, questions: JevQuestions) {
    this.calls += 1;
    this.asked.push(questions);
    return { body: { model: this.recorded.modelo, answers: this.recorded.answers, usage: this.recorded.usage }, requestId: 'req_grabado', requests: 1, ms: 5 };
  }
  async credentialPresent() { return true; }
}

function service(catalog: Catalog, jev: JevCaller, audit: AuditRecord[] = []): DecisionService {
  return new DecisionService({
    catalog, jev, redact: true,
    limits: new Limits({ perMinute: 600, burst: 100, dailyInputTokens: 1_000_000, concurrency: 4 }),
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
    for (const shell of ["awk '{print $1}' registro.log", 'echo "$2 ${10}" > salida', 'git log -n 5']) expect(await origen(shell), shell).toBe('jev');
    for (const monto of ['pagar $20 del dominio', 'renovar por 12 dólares', 'cobrar USD 300', 'subir el plan a $9.99']) expect(await origen(monto), monto).toBe('prefiltro');
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
      limits: new Limits({ perMinute: 60, burst: 5, dailyInputTokens: 10_000, concurrency: 1 }),
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
