import { invalid, DecisionError } from './errors.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type QuestionType = 'noul' | 'choice' | 'score';

/** A question exactly as the Jev API takes it; nothing else may travel in it. */
export interface JevQuestion {
  readonly type: QuestionType;
  readonly instructions: JsonValue;
  readonly criteria?: JsonValue;
}

export type JevQuestions = Readonly<Record<string, JevQuestion>>;

/* Limits sit below what Jev accepts (64k tokens, 255 options, 10 levels) so a request is refused
   here, for free, instead of upstream after being paid for. */
export const LIMITS = {
  maxQuestions: 32,
  maxStateBytes: 64 * 1024,
  maxQuestionBytes: 16 * 1024,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  maxDepth: 32,
} as const;

export const QUESTION_ID = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,127}$/u;
const OPTION_KEY_MAX = 128;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertJsonValue(value: unknown, context: string, depth = 0): asserts value is JsonValue {
  if (depth > LIMITS.maxDepth) throw invalid(`${context} anida demasiado`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${context} contiene un número no finito`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, context, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertJsonValue(item, context, depth + 1);
    return;
  }
  throw invalid(`${context} no es JSON`);
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function nonEmpty(value: JsonValue): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function assertRubric(value: unknown, context: string): void {
  assertJsonValue(value, context);
  if (!nonEmpty(value)) throw invalid(`${context} está vacío`);
}

function validateCriteria(id: string, type: QuestionType, criteria: unknown): void {
  const context = `questions.${id}.criteria`;
  if (type === 'noul') {
    if (criteria === undefined) return;
    if (!isPlainObject(criteria)) throw invalid(`${context} de un noul debe ser un objeto {true,false}`);
    for (const [key, rubric] of Object.entries(criteria)) {
      if (key !== 'true' && key !== 'false') throw invalid(`${context} sólo admite 'true' y 'false'`);
      assertRubric(rubric, `${context}.${key}`);
    }
    return;
  }
  if (type === 'choice') {
    if (!isPlainObject(criteria)) throw invalid(`${context} de un choice debe mapear opción → descripción`);
    const options = Object.keys(criteria);
    if (options.length < 2 || options.length > LIMITS.maxChoiceOptions) {
      throw invalid(`${context} necesita entre 2 y ${String(LIMITS.maxChoiceOptions)} opciones`);
    }
    for (const option of options) {
      if (option.trim().length === 0 || option.length > OPTION_KEY_MAX) throw invalid(`${context} tiene una opción inválida`);
      const rubric = criteria[option];
      if (rubric !== null) assertRubric(rubric, `${context}.${option}`);
    }
    return;
  }
  if (!Array.isArray(criteria)) throw invalid(`${context} de un score debe ser una lista ordenada de niveles`);
  if (criteria.length < LIMITS.minScoreLevels || criteria.length > LIMITS.maxScoreLevels) {
    throw invalid(`${context} necesita entre ${String(LIMITS.minScoreLevels)} y ${String(LIMITS.maxScoreLevels)} niveles`);
  }
  criteria.forEach((level, index) => { assertRubric(level, `${context}[${String(index)}]`); });
}

export function validateQuestion(id: string, value: unknown): JevQuestion {
  if (!QUESTION_ID.test(id)) throw invalid(`el id de pregunta '${id.slice(0, 40)}' no es válido`);
  if (!isPlainObject(value)) throw invalid(`questions.${id} debe ser un objeto`);
  const extra = Object.keys(value).find((key) => !['type', 'instructions', 'criteria'].includes(key));
  if (extra !== undefined) throw invalid(`questions.${id} tiene un campo desconocido '${extra.slice(0, 40)}'`);
  const type = value.type;
  if (type !== 'noul' && type !== 'choice' && type !== 'score') {
    throw invalid(`questions.${id}.type debe ser noul, choice o score`);
  }
  assertRubric(value.instructions, `questions.${id}.instructions`);
  validateCriteria(id, type, value.criteria);
  if (jsonBytes(value) > LIMITS.maxQuestionBytes) throw invalid(`questions.${id} supera ${String(LIMITS.maxQuestionBytes)} bytes`);
  const instructions = value.instructions as JsonValue;
  return value.criteria === undefined ? { type, instructions } : { type, instructions, criteria: value.criteria as JsonValue };
}

export function validateQuestions(value: unknown): JevQuestions {
  if (!isPlainObject(value)) throw invalid('questions debe ser un objeto id → pregunta');
  const entries = Object.entries(value);
  if (entries.length === 0) throw invalid('questions no puede estar vacío');
  if (entries.length > LIMITS.maxQuestions) throw invalid(`como máximo ${String(LIMITS.maxQuestions)} preguntas por decisión`);
  const questions: Record<string, JevQuestion> = {};
  for (const [id, question] of entries) questions[id] = validateQuestion(id, question);
  return questions;
}

/** Jev takes text, an object or an array; the size bound is ours, measured on the JSON that is sent. */
export function validateState(value: unknown): JsonValue {
  if (value === undefined) throw invalid('state es obligatorio');
  assertJsonValue(value, 'state');
  if (typeof value !== 'string' && !Array.isArray(value) && !isPlainObject(value)) {
    throw invalid('state debe ser texto, un objeto o una lista');
  }
  if (!nonEmpty(value)) throw invalid('state está vacío');
  if (jsonBytes(value) > LIMITS.maxStateBytes) {
    throw new DecisionError('state_demasiado_grande', `state supera ${String(LIMITS.maxStateBytes)} bytes: recortalo a lo que la pregunta necesita`);
  }
  return value;
}

export function criteriaOptions(question: JevQuestion): string[] {
  return question.type === 'choice' && isPlainObject(question.criteria) ? Object.keys(question.criteria) : [];
}

export function scoreLevels(question: JevQuestion): number {
  return question.type === 'score' && Array.isArray(question.criteria) ? question.criteria.length : 0;
}

export function levelMap(questions: JevQuestions): Map<string, number> {
  const levels = new Map<string, number>();
  for (const [id, question] of Object.entries(questions)) if (question.type === 'score') levels.set(id, scoreLevels(question));
  return levels;
}
