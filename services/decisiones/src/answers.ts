import { DecisionError } from './errors.js';
import { criteriaOptions, isPlainObject, scoreLevels, type JevQuestions } from './questions.js';

export interface NoulAnswer { readonly type: 'noul'; readonly noul: number }
export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage { readonly input_tokens: number; readonly output_tokens: number }

export interface ParsedJevResponse {
  readonly model: string;
  readonly answers: ReadonlyMap<string, JevAnswer>;
  readonly usage: JevUsage;
}

/** Thresholds that turn a probability into "firm enough to act without an LLM". */
export interface Thresholds {
  readonly confianza: number;
  readonly noul_si: number;
  readonly noul_no: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { confianza: 0.6, noul_si: 0.8, noul_no: 0.2 };

function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function malformed(detail: string): DecisionError {
  return new DecisionError('jev_respuesta_invalida', `Jev devolvió una respuesta con forma inesperada: ${detail}`);
}

function probabilities(value: unknown, id: string): Record<string, number> {
  if (!isPlainObject(value)) throw malformed(`${id}.probabilities`);
  const result: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!unit(probability)) throw malformed(`${id}.probabilities.${key.slice(0, 40)}`);
    result[key] = probability;
  }
  return result;
}

function parseAnswer(id: string, value: unknown, expected: JevQuestions[string]): JevAnswer {
  if (!isPlainObject(value) || value.type !== expected.type) throw malformed(`${id} no coincide con su pregunta`);
  if (expected.type === 'noul') {
    if (!unit(value.noul)) throw malformed(`${id}.noul`);
    return { type: 'noul', noul: value.noul };
  }
  if (!unit(value.confidence)) throw malformed(`${id}.confidence`);
  const distribution = probabilities(value.probabilities, id);
  if (expected.type === 'choice') {
    if (typeof value.choice !== 'string' || !criteriaOptions(expected).includes(value.choice)) throw malformed(`${id}.choice`);
    return { type: 'choice', choice: value.choice, probabilities: distribution, confidence: value.confidence };
  }
  const levels = scoreLevels(expected);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > levels - 1) {
    throw malformed(`${id}.score`);
  }
  return { type: 'score', score: value.score, probabilities: distribution, confidence: value.confidence };
}

export function parseJevResponse(value: unknown, questions: JevQuestions): ParsedJevResponse {
  if (!isPlainObject(value) || !isPlainObject(value.answers)) throw malformed('falta answers');
  const answers = new Map<string, JevAnswer>();
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in value.answers)) throw malformed(`falta la respuesta de ${id.slice(0, 64)}`);
    answers.set(id, parseAnswer(id, value.answers[id], question));
  }
  const usage = isPlainObject(value.usage) ? value.usage : {};
  const count = (field: unknown): number => (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : 0);
  return {
    model: typeof value.model === 'string' ? value.model.slice(0, 64) : 'desconocido',
    answers,
    usage: { input_tokens: count(usage.input_tokens), output_tokens: count(usage.output_tokens) },
  };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function top(distribution: Readonly<Record<string, number>>, count: number): { opcion: string; p: number }[] {
  return Object.entries(distribution)
    .sort(([, left], [, right]) => right - left)
    .slice(0, count)
    .map(([opcion, p]) => ({ opcion, p: round(p) }));
}

/** Certainty on one scale for all three types: a noul has no confidence, so its distance to 0.5 is used. */
export function certainty(answer: JevAnswer): number {
  return answer.type === 'noul' ? round(Math.abs(2 * answer.noul - 1)) : round(answer.confidence);
}

export function isFirm(answer: JevAnswer, thresholds: Thresholds): boolean {
  if (answer.type === 'noul') return answer.noul >= thresholds.noul_si || answer.noul <= thresholds.noul_no;
  return answer.confidence >= thresholds.confianza;
}

/** The public, typed view of one answer that agents read. */
export function signalView(answer: JevAnswer, levels: number, thresholds: Thresholds): Record<string, unknown> {
  const firme = isFirm(answer, thresholds);
  if (answer.type === 'noul') {
    const respuesta = answer.noul >= thresholds.noul_si ? 'si' : answer.noul <= thresholds.noul_no ? 'no' : 'incierto';
    return { tipo: 'noul', p: round(answer.noul), respuesta, certeza: certainty(answer), firme };
  }
  if (answer.type === 'choice') {
    return {
      tipo: 'choice',
      eleccion: answer.choice,
      p_eleccion: round(answer.probabilities[answer.choice] ?? 0),
      confianza: round(answer.confidence),
      top: top(answer.probabilities, 3),
      certeza: certainty(answer),
      firme,
    };
  }
  const [probable] = top(answer.probabilities, 1);
  return {
    tipo: 'score',
    puntaje: round(answer.score),
    niveles: levels,
    normalizado: levels > 1 ? round(answer.score / (levels - 1)) : 0,
    nivel_probable: probable === undefined ? null : Number(probable.opcion),
    probabilidades: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => [key, round(value)])),
    confianza: round(answer.confidence),
    certeza: certainty(answer),
    firme,
  };
}

export function validateThresholds(value: unknown): Thresholds {
  if (value === undefined) return DEFAULT_THRESHOLDS;
  if (!isPlainObject(value)) throw new DecisionError('solicitud_invalida', 'umbrales debe ser un objeto');
  const result: Record<string, number> = { ...DEFAULT_THRESHOLDS };
  for (const [key, threshold] of Object.entries(value)) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new DecisionError('solicitud_invalida', `umbrales.${key.slice(0, 40)} no existe`);
    if (!unit(threshold)) throw new DecisionError('solicitud_invalida', `umbrales.${key} debe estar entre 0 y 1`);
    result[key] = threshold;
  }
  const thresholds = result as unknown as Thresholds;
  if (thresholds.noul_no >= thresholds.noul_si) throw new DecisionError('solicitud_invalida', 'umbrales.noul_no debe ser menor que noul_si');
  return thresholds;
}
