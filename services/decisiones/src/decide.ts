import { randomUUID } from 'node:crypto';
import { redactSecretsDeep } from '@cauce/protocol';
import {
  certainty, parseJevResponse, signalView, validateThresholds,
  type JevAnswer, type ParsedJevResponse, type Thresholds,
} from './answers.js';
import { stateDigest, type AuditRecord, type AuditSink } from './audit.js';
import {
  expandQuestions, fieldText, setResolver, summary,
  type Catalog, type Outcome, type Plantilla,
} from './catalog.js';
import { DecisionError, invalid, type FallbackOutcome } from './errors.js';
import type { Caller } from './identity.js';
import type { JevCaller } from './jev-client.js';
import type { Limits } from './limits.js';
import { isPlainObject, levelMap, validateQuestions, validateState, type JevQuestions, type JsonValue } from './questions.js';
import { computeIndicator, evaluate, resolveTemplate, type EvaluationScope } from './rules.js';

export interface DecisionServiceOptions {
  readonly catalog: Catalog;
  readonly jev: JevCaller;
  readonly limits: Limits;
  readonly audit: AuditSink;
  readonly redact: boolean;
  /** Templates marked `requiere_habilitacion` that an operator switched on. */
  readonly enabledTemplates?: ReadonlySet<string>;
  readonly newId?: () => string;
}

interface DecideRequest {
  readonly plantilla?: string;
  readonly state: JsonValue;
  readonly questions?: JevQuestions;
  readonly restringir?: unknown;
  readonly thresholds: Thresholds;
}

const REQUEST_KEYS = new Set(['plantilla', 'state', 'questions', 'opciones', 'umbrales']);
const IDENTITY_KEYS = /^(alias|tenant|tenant_id|actor_alias|from|remitente_alias|identidad)$/u;
export const PREFILTER_SCAN = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const FREE_FALLBACK: FallbackOutcome = {
  decision: 'llm', valor: null, caer_a_llm: true,
  motivo: 'Jev no pudo decidir: resolvelo con tu propio razonamiento',
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

function parseRequest(body: unknown): DecideRequest {
  if (!isPlainObject(body)) throw invalid('el cuerpo debe ser un objeto JSON');
  for (const key of Object.keys(body)) {
    if (IDENTITY_KEYS.test(key)) throw invalid(`'${key}' no se acepta: la identidad sale del certificado mTLS`);
    if (!REQUEST_KEYS.has(key)) throw invalid(`campo desconocido '${key.slice(0, 40)}'`);
  }
  const hasTemplate = body.plantilla !== undefined;
  if (hasTemplate === (body.questions !== undefined)) throw invalid('mandá plantilla o questions, exactamente uno');
  if (hasTemplate && typeof body.plantilla !== 'string') throw invalid('plantilla es el id de una plantilla del catálogo');
  const options = body.opciones;
  if (options !== undefined && (!isPlainObject(options) || Object.keys(options).some((key) => key !== 'restringir'))) {
    throw invalid('opciones sólo admite restringir');
  }
  if (!hasTemplate && options !== undefined) throw invalid('opciones sólo aplica a plantillas');
  return {
    state: validateState(body.state),
    thresholds: validateThresholds(body.umbrales),
    ...(hasTemplate ? { plantilla: body.plantilla as string } : { questions: validateQuestions(body.questions) }),
    ...(options?.restringir === undefined ? {} : { restringir: options.restringir }),
  };
}

function resolveOutcome(outcome: Outcome, answers: ReadonlyMap<string, JevAnswer>): FallbackOutcome | undefined {
  const decision = resolveTemplate(outcome.decision, answers);
  const valor = outcome.valor === undefined ? null : resolveTemplate(outcome.valor, answers);
  if (decision === undefined || valor === undefined) return undefined;
  return { decision, valor, motivo: outcome.motivo, caer_a_llm: outcome.llm };
}

function staticOutcome(outcome: Outcome): FallbackOutcome {
  return { decision: outcome.decision, valor: outcome.valor ?? null, motivo: outcome.motivo, caer_a_llm: outcome.llm };
}

export class DecisionService {
  private readonly newId: () => string;

  constructor(private readonly options: DecisionServiceOptions) {
    this.newId = options.newId ?? (() => `dec_${randomUUID()}`);
  }

  get catalog(): Catalog { return this.options.catalog; }

  private enabled(plantilla: Plantilla): boolean {
    return plantilla.requiresEnablement === undefined || this.options.enabledTemplates?.has(plantilla.id) === true;
  }

  listing(): Record<string, unknown> {
    const { catalog } = this.options;
    return {
      version_catalogo: catalog.version,
      modelo_calibrado: catalog.calibratedModel,
      plantillas: [...catalog.plantillas.values()].map((plantilla) => summary(plantilla, this.enabled(plantilla))),
    };
  }

  detail(id: string): Record<string, unknown> {
    const plantilla = this.options.catalog.plantillas.get(id);
    if (plantilla === undefined) throw new DecisionError('plantilla_desconocida', `no existe la plantilla '${id.slice(0, 64)}'`);
    return { version_catalogo: this.options.catalog.version, plantilla: plantilla.definition };
  }

  async decide(caller: Caller, body: unknown): Promise<Record<string, unknown>> {
    const request = parseRequest(body);
    const plantilla = request.plantilla === undefined ? undefined : this.options.catalog.plantillas.get(request.plantilla);
    if (request.plantilla !== undefined && plantilla === undefined) {
      throw new DecisionError('plantilla_desconocida', `no existe la plantilla '${request.plantilla.slice(0, 64)}': usá listar_plantillas`);
    }
    const fallback = plantilla === undefined ? FREE_FALLBACK : staticOutcome(plantilla.siFalla);
    if (plantilla !== undefined && !this.enabled(plantilla)) {
      throw new DecisionError('plantilla_deshabilitada', `${plantilla.id} está apagada: ${plantilla.requiresEnablement ?? ''}`, { respaldo: fallback });
    }
    try {
      this.options.limits.admit(caller.alias);
    } catch (error) {
      throw error instanceof DecisionError ? error.withFallback(fallback) : error;
    }
    return plantilla === undefined
      ? this.decideFree(caller, request, request.questions ?? {})
      : this.decideTemplate(caller, request, plantilla);
  }

  private baseAudit(caller: Caller, plantilla: Plantilla | undefined, questions: JevQuestions, state: JsonValue) {
    const digest = stateDigest(JSON.stringify(state));
    return {
      id: this.newId(),
      tenant: caller.tenant,
      alias: caller.alias,
      plantilla: plantilla?.id ?? null,
      version_plantilla: plantilla?.version ?? null,
      version_catalogo: this.options.catalog.version,
      preguntas: Object.entries(questions).map(([id, question]) => ({ id, tipo: question.type })),
      state_sha256: digest.sha256,
      state_bytes: digest.bytes,
    };
  }

  private async write(record: AuditRecord): Promise<void> {
    await this.options.audit.write(record);
  }

  private prefilter(caller: Caller, plantilla: Plantilla, state: JsonValue): FallbackOutcome | undefined {
    for (const entry of plantilla.prefilters) {
      if (entry.soloAlias !== undefined && !entry.soloAlias.includes(caller.alias)) continue;
      if (entry.exceptoAlias?.includes(caller.alias) === true) continue;
      for (const campo of entry.campos) {
        const value = fieldText(state, campo);
        if (value !== undefined && entry.patron.test(value.slice(0, PREFILTER_SCAN))) return staticOutcome(entry.entonces);
      }
    }
    return undefined;
  }

  /** Sends to Jev and parses; every failure is audited and carries the fallback the caller must apply. */
  private async ask(
    base: ReturnType<DecisionService['baseAudit']>, questions: JevQuestions, state: JsonValue, fallback: FallbackOutcome,
  ): Promise<{ parsed: ParsedJevResponse; requestId: string | null; ms: number; requests: number; redactions: number }> {
    const started = Date.now();
    const redaction = redactSecretsDeep(state, { enabled: this.options.redact });
    try {
      if (redaction.unscanned !== undefined) throw invalid('state no se pudo revisar entero en busca de secretos: recortalo');
      this.options.limits.assertDailyBudget(base.alias);
      const call = await this.options.limits.withSlot(() => this.options.jev.evaluate(redaction.value, questions));
      const parsed = parseJevResponse(call.body, questions);
      this.options.limits.charge(base.alias, parsed.usage.input_tokens);
      const requestId = call.requestId !== undefined && REQUEST_ID.test(call.requestId) ? call.requestId : null;
      return { parsed, requestId, ms: call.ms, requests: call.requests, redactions: redaction.count };
    } catch (error) {
      const failure = error instanceof DecisionError ? error : new DecisionError('jev_error', 'fallo inesperado del servicio de decisiones');
      await this.write({
        ...base, ts: new Date().toISOString(), redacciones: redaction.count, origen: 'fallo', estado: failure.code,
        ms: Date.now() - started, solicitudes_jev: failure.details.requests ?? 0, modelo: null, jev_request_id: null, usage: null,
        certeza: {}, certeza_min: null, decision: fallback.decision, caer_a_llm: fallback.caer_a_llm,
      });
      throw failure.withFallback(fallback);
    }
  }

  private jevFields(result: Awaited<ReturnType<DecisionService['ask']>>): Record<string, unknown> {
    const calibrated = this.options.catalog.calibratedModel;
    return {
      modelo: result.parsed.model,
      modelo_calibrado: calibrated,
      ...(result.parsed.model === calibrated ? {} : { modelo_distinto_al_calibrado: true }),
      jev_request_id: result.requestId,
      ms: result.ms,
      solicitudes_jev: result.requests,
      usage: result.parsed.usage,
      redacciones: result.redactions,
    };
  }

  private certainties(answers: ReadonlyMap<string, JevAnswer>): { map: Record<string, number>; min: number | null } {
    const map = Object.fromEntries([...answers].map(([id, answer]) => [id, certainty(answer)]));
    const values = Object.values(map);
    return { map, min: values.length === 0 ? null : Math.min(...values) };
  }

  private async decideFree(caller: Caller, request: DecideRequest, questions: JevQuestions): Promise<Record<string, unknown>> {
    const base = this.baseAudit(caller, undefined, questions, request.state);
    const result = await this.ask(base, questions, request.state, FREE_FALLBACK);
    const answers = result.parsed.answers;
    const levels = levelMap(questions);
    const views: Record<string, unknown> = {};
    const uncertain: string[] = [];
    for (const [id, answer] of answers) {
      const view = signalView(answer, levels.get(id) ?? 0, request.thresholds);
      views[id] = view;
      if (view.firme !== true) uncertain.push(id);
    }
    const { map, min } = this.certainties(answers);
    const fallsBack = uncertain.length > 0;
    await this.write({
      ...base, ts: new Date().toISOString(), redacciones: result.redactions, origen: 'jev', estado: 'ok', ms: result.ms,
      solicitudes_jev: result.requests, modelo: result.parsed.model, jev_request_id: result.requestId,
      usage: result.parsed.usage, certeza: map, certeza_min: min, decision: null, caer_a_llm: fallsBack,
    });
    return {
      id: base.id,
      origen: 'jev',
      respuestas: views,
      caer_a_llm: fallsBack,
      inciertas: uncertain,
      confianza: min,
      motivo: fallsBack
        ? `respuestas bajo el umbral (${uncertain.join(', ')}): usalas como pista y decidí con tu propio razonamiento`
        : 'todas las respuestas superan el umbral',
      ...this.jevFields(result),
    };
  }

  private async decideTemplate(caller: Caller, request: DecideRequest, plantilla: Plantilla): Promise<Record<string, unknown>> {
    const { state } = request;
    if (!isPlainObject(state)) throw invalid(`la plantilla ${plantilla.id} espera state como objeto`);
    const missing = plantilla.stateRequerido.filter((field) => {
      const value = fieldText(state, field);
      return value === undefined || value.trim().length === 0;
    });
    if (missing.length > 0) throw invalid(`a state le falta: ${missing.join(', ')}`);
    const fallback = staticOutcome(plantilla.siFalla);
    const shortcut = this.prefilter(caller, plantilla, state);
    if (shortcut !== undefined) {
      const base = this.baseAudit(caller, plantilla, {}, state);
      await this.write({
        ...base, ts: new Date().toISOString(), redacciones: 0, origen: 'prefiltro', estado: 'ok', ms: 0, solicitudes_jev: 0,
        modelo: null, jev_request_id: null, usage: null, certeza: {}, certeza_min: null,
        decision: shortcut.decision, caer_a_llm: shortcut.caer_a_llm,
      });
      return {
        id: base.id, plantilla: plantilla.id, version_plantilla: plantilla.version,
        version_catalogo: this.options.catalog.version, origen: 'prefiltro', ...shortcut, confianza: 1, marcas: [],
      };
    }
    const expanded = expandQuestions(plantilla, state, request.restringir);
    const base = this.baseAudit(caller, plantilla, expanded.questions, state);
    const result = await this.ask(base, expanded.questions, state, fallback);
    const answers = result.parsed.answers;
    const partial: EvaluationScope = { answers, levels: expanded.levels, indicators: new Map(), sets: setResolver(plantilla, caller.alias) };
    const indicators = new Map<string, number>();
    for (const [name, indicator] of plantilla.indicators) {
      const value = computeIndicator(indicator, partial);
      if (value !== undefined && Number.isFinite(value)) indicators.set(name, value);
    }
    const scope: EvaluationScope = { ...partial, indicators };
    const fired = plantilla.rules.find((rule) => evaluate(rule.si, scope) === true);
    const outcome = (fired === undefined ? undefined : resolveOutcome(fired.entonces, answers)) ?? staticOutcome(plantilla.sino);
    const marks = [...plantilla.marks].filter(([, condition]) => evaluate(condition, scope) === true).map(([name]) => name);
    const views = Object.fromEntries([...answers].map(([id, answer]) => [id, signalView(answer, expanded.levels.get(id) ?? 0, request.thresholds)]));
    const { map, min } = this.certainties(answers);
    await this.write({
      ...base, ts: new Date().toISOString(), redacciones: result.redactions, origen: 'jev', estado: 'ok', ms: result.ms,
      solicitudes_jev: result.requests, modelo: result.parsed.model, jev_request_id: result.requestId,
      usage: result.parsed.usage, certeza: map, certeza_min: min, decision: outcome.decision, caer_a_llm: outcome.caer_a_llm,
    });
    return {
      id: base.id,
      plantilla: plantilla.id,
      version_plantilla: plantilla.version,
      version_catalogo: this.options.catalog.version,
      origen: 'jev',
      ...outcome,
      confianza: min,
      marcas: marks,
      indicadores: Object.fromEntries([...indicators].map(([name, value]) => [name, round(value)])),
      senales: views,
      ...this.jevFields(result),
    };
  }
}
