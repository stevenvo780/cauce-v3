import { certainty, type JevAnswer } from './answers.js';
import { isPlainObject } from './questions.js';

/**
 * The declarative rule language of the catalog. A condition is tri-state: `null` means an answer it
 * needs is missing, and a rule only fires on `true`, so an absent answer can never trigger a decision.
 */
const OPERATORS = ['>=', '>', '<=', '<'] as const;
type Operator = (typeof OPERATORS)[number];
type Comparison = Partial<Record<Operator, number>>;

/** `[ids]`, `@set` (resolved per caller alias) or `prefix::*` (every question with that prefix). */
export type SetRef = readonly string[] | string;

export type Condition =
  | { readonly todas: readonly Condition[] }
  | { readonly alguna: readonly Condition[] }
  | { readonly no: Condition }
  | { readonly eleccion: string; readonly es?: string; readonly no_es?: string; readonly en?: readonly string[] }
  | ({ readonly p: string } & Comparison)
  | ({ readonly confianza: string } & Comparison)
  | ({ readonly prob: string; readonly opcion: string } & Comparison)
  | ({ readonly prob_elegida: string } & Comparison)
  | ({ readonly puntaje: string } & Comparison)
  | ({ readonly normalizado: string } & Comparison)
  | ({ readonly max: SetRef } & Comparison)
  | ({ readonly min: SetRef } & Comparison)
  | ({ readonly indicador: string } & Comparison);

export type Indicator =
  | { readonly ponderado: Readonly<Record<string, number>> }
  | { readonly max: SetRef }
  | { readonly min: SetRef };

export interface EvaluationScope {
  readonly answers: ReadonlyMap<string, JevAnswer>;
  readonly levels: ReadonlyMap<string, number>;
  readonly indicators: ReadonlyMap<string, number>;
  readonly sets: (name: string) => readonly string[];
  /** Only needed to weigh how sure a condition on an indicator is. */
  readonly indicatorDefinitions?: ReadonlyMap<string, Indicator>;
}

/** What a rule references, so the loader can check every id against the template's questions. */
export interface References {
  readonly ids: string[];
  readonly sets: SetRef[];
  readonly indicators: string[];
}

const SUBJECTS = ['p', 'confianza', 'prob_elegida', 'puntaje', 'normalizado', 'max', 'min', 'indicador'] as const;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function parseComparison(value: Record<string, unknown>, path: string): Comparison {
  const comparison: Comparison = {};
  for (const operator of OPERATORS) {
    const bound = value[operator];
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isFinite(bound)) fail(path, `'${operator}' debe ser un número`);
    comparison[operator] = bound;
  }
  if (Object.keys(comparison).length === 0) fail(path, 'falta un comparador (>=, >, <=, <)');
  return comparison;
}

function parseSetRef(value: unknown, path: string): SetRef {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) return value;
  return fail(path, 'un conjunto es una lista de ids, @nombre o prefijo::*');
}

export function parseCondition(value: unknown, path: string, refs: References): Condition {
  if (!isPlainObject(value)) return fail(path, 'una condición es un objeto');
  const keys = Object.keys(value);
  if ('todas' in value || 'alguna' in value) {
    const key = 'todas' in value ? 'todas' : 'alguna';
    const list = value[key];
    if (keys.length !== 1 || !Array.isArray(list) || list.length === 0) fail(path, `'${key}' es una lista no vacía y va sola`);
    const parsed = list.map((item, index) => parseCondition(item, `${path}.${key}[${String(index)}]`, refs));
    return key === 'todas' ? { todas: parsed } : { alguna: parsed };
  }
  if ('no' in value) {
    if (keys.length !== 1) fail(path, "'no' va solo");
    return { no: parseCondition(value.no, `${path}.no`, refs) };
  }
  if ('eleccion' in value) {
    const id = value.eleccion;
    if (typeof id !== 'string') return fail(path, "'eleccion' es un id de pregunta");
    const allowed = new Set(['eleccion', 'es', 'no_es', 'en']);
    if (keys.some((key) => !allowed.has(key)) || keys.length !== 2) fail(path, "'eleccion' lleva exactamente uno de es / no_es / en");
    refs.ids.push(id);
    if (typeof value.es === 'string') return { eleccion: id, es: value.es };
    if (typeof value.no_es === 'string') return { eleccion: id, no_es: value.no_es };
    if (Array.isArray(value.en) && value.en.every((item) => typeof item === 'string')) return { eleccion: id, en: value.en };
    return fail(path, "'es'/'no_es' son texto y 'en' una lista de texto");
  }
  if ('prob' in value) {
    const extra = keys.find((key) => !['prob', 'opcion', ...OPERATORS].includes(key));
    const { prob, opcion } = value;
    if (extra !== undefined || typeof prob !== 'string' || typeof opcion !== 'string') {
      return fail(path, "'prob' lleva un id, 'opcion' y comparadores");
    }
    refs.ids.push(prob);
    return { prob, opcion, ...parseComparison(value, path) };
  }
  const subject = SUBJECTS.find((name) => name in value);
  if (subject === undefined) return fail(path, `condición desconocida (${keys.join(', ').slice(0, 60)})`);
  const extra = keys.find((key) => key !== subject && !(OPERATORS as readonly string[]).includes(key));
  if (extra !== undefined) fail(path, `campo inesperado '${extra}'`);
  const comparison = parseComparison(value, path);
  const target = value[subject];
  if (subject === 'max' || subject === 'min') {
    const set = parseSetRef(target, `${path}.${subject}`);
    refs.sets.push(set);
    return subject === 'max' ? { max: set, ...comparison } : { min: set, ...comparison };
  }
  if (typeof target !== 'string' || target.length === 0) return fail(path, `'${subject}' es un id`);
  if (subject === 'indicador') refs.indicators.push(target);
  else refs.ids.push(target);
  return { [subject]: target, ...comparison } as Condition;
}

export function parseIndicator(value: unknown, path: string, refs: References): Indicator {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return fail(path, 'un indicador es {ponderado}, {max} o {min}');
  if ('ponderado' in value) {
    const weights = value.ponderado;
    if (!isPlainObject(weights) || Object.keys(weights).length === 0) return fail(path, 'ponderado mapea id → peso');
    const parsed: Record<string, number> = {};
    for (const [id, weight] of Object.entries(weights)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight)) fail(`${path}.ponderado.${id}`, 'el peso es un número');
      parsed[id] = weight;
      refs.ids.push(id);
    }
    return { ponderado: parsed };
  }
  const key = 'max' in value ? 'max' : 'min' in value ? 'min' : undefined;
  if (key === undefined) return fail(path, 'un indicador es {ponderado}, {max} o {min}');
  const set = parseSetRef(value[key], `${path}.${key}`);
  refs.sets.push(set);
  return key === 'max' ? { max: set } : { min: set };
}

/** Replaces `{eleccion:<id>}` with the chosen option of that choice; undefined when it is unknown. */
export function resolveTemplate(text: string, answers: ReadonlyMap<string, JevAnswer>): string | undefined {
  let resolved = '';
  let cursor = 0;
  for (const match of text.matchAll(/\{eleccion:([^{}]+)\}/gu)) {
    const answer = answers.get(match[1] ?? '');
    if (answer?.type !== 'choice') return undefined;
    resolved += text.slice(cursor, match.index) + answer.choice;
    cursor = match.index + match[0].length;
  }
  return resolved + text.slice(cursor);
}

export function hasTemplate(text: string): boolean {
  return /\{eleccion:[^{}]+\}/u.test(text);
}

function resolveSet(ref: SetRef, scope: EvaluationScope): readonly string[] {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('@')) return scope.sets(ref.slice(1));
  if (ref.endsWith('*')) {
    const prefix = ref.slice(0, -1);
    return [...scope.answers.keys()].filter((id) => id.startsWith(prefix));
  }
  return [ref];
}

function compare(value: number | undefined, comparison: Comparison): boolean | null {
  if (value === undefined || Number.isNaN(value)) return null;
  for (const [operator, bound] of Object.entries(comparison) as [Operator, number][]) {
    const holds = operator === '>=' ? value >= bound : operator === '>' ? value > bound : operator === '<=' ? value <= bound : value < bound;
    if (!holds) return false;
  }
  return true;
}

function comparisonOf(condition: object): Comparison {
  const comparison: Comparison = {};
  for (const operator of OPERATORS) {
    const bound = (condition as Comparison)[operator];
    if (bound !== undefined) comparison[operator] = bound;
  }
  return comparison;
}

function noulValue(id: string, scope: EvaluationScope): number | undefined {
  const answer = scope.answers.get(id);
  return answer?.type === 'noul' ? answer.noul : undefined;
}

/** Normalised to [0,1]: a noul's p, a score over its top level, a choice's winning probability. */
export function normalized(id: string, scope: EvaluationScope): number | undefined {
  const answer = scope.answers.get(id);
  if (answer === undefined) return undefined;
  if (answer.type === 'noul') return answer.noul;
  if (answer.type === 'choice') return answer.probabilities[answer.choice];
  const levels = scope.levels.get(id) ?? 0;
  return levels > 1 ? answer.score / (levels - 1) : undefined;
}

function aggregate(ref: SetRef, kind: 'max' | 'min', scope: EvaluationScope): number | undefined {
  const values = resolveSet(ref, scope).map((id) => noulValue(id, scope));
  if (values.some((value) => value === undefined)) return undefined;
  const numbers = values as number[];
  if (numbers.length === 0) return kind === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return kind === 'max' ? Math.max(...numbers) : Math.min(...numbers);
}

export function computeIndicator(indicator: Indicator, scope: EvaluationScope): number | undefined {
  if ('ponderado' in indicator) {
    let total = 0;
    for (const [id, weight] of Object.entries(indicator.ponderado)) {
      const value = normalized(id, scope);
      if (value === undefined) return undefined;
      total += weight * value;
    }
    return total;
  }
  return 'max' in indicator ? aggregate(indicator.max, 'max', scope) : aggregate(indicator.min, 'min', scope);
}

function resolvedId(id: string, scope: EvaluationScope): string | undefined {
  return hasTemplate(id) ? resolveTemplate(id, scope.answers) : id;
}

export function evaluate(condition: Condition, scope: EvaluationScope): boolean | null {
  if ('todas' in condition) {
    const results = condition.todas.map((item) => evaluate(item, scope));
    return results.includes(false) ? false : results.includes(null) ? null : true;
  }
  if ('alguna' in condition) {
    const results = condition.alguna.map((item) => evaluate(item, scope));
    return results.includes(true) ? true : results.includes(null) ? null : false;
  }
  if ('no' in condition) {
    const inner = evaluate(condition.no, scope);
    return inner === null ? null : !inner;
  }
  if ('eleccion' in condition) {
    const answer = scope.answers.get(condition.eleccion);
    if (answer?.type !== 'choice') return null;
    if (condition.es !== undefined) return answer.choice === condition.es;
    if (condition.no_es !== undefined) return answer.choice !== condition.no_es;
    return (condition.en ?? []).includes(answer.choice);
  }
  const comparison = comparisonOf(condition);
  if ('prob' in condition) {
    const answer = scope.answers.get(condition.prob);
    return answer === undefined || answer.type === 'noul' ? null : compare(answer.probabilities[condition.opcion] ?? 0, comparison);
  }
  if ('max' in condition) return compare(aggregate(condition.max, 'max', scope), comparison);
  if ('min' in condition) return compare(aggregate(condition.min, 'min', scope), comparison);
  if ('indicador' in condition) return compare(scope.indicators.get(condition.indicador), comparison);
  if ('p' in condition) {
    const id = resolvedId(condition.p, scope);
    return id === undefined ? null : compare(noulValue(id, scope), comparison);
  }
  if ('normalizado' in condition) return compare(normalized(condition.normalizado, scope), comparison);
  const id = 'confianza' in condition ? condition.confianza : 'prob_elegida' in condition ? condition.prob_elegida : condition.puntaje;
  const answer = scope.answers.get(id);
  if (answer === undefined || answer.type === 'noul') return null;
  if ('confianza' in condition) return compare(answer.confidence, comparison);
  if ('prob_elegida' in condition) return compare(answer.type === 'choice' ? answer.probabilities[answer.choice] : undefined, comparison);
  return compare(answer.type === 'score' ? answer.score : undefined, comparison);
}

function answerCertainty(id: string | undefined, scope: EvaluationScope): number {
  const answer = id === undefined ? undefined : scope.answers.get(id);
  return answer === undefined ? 0 : certainty(answer);
}

/* The compared value of a max/min is one element's: that element is what the comparison rests on. */
function extremeCertainty(ref: SetRef, kind: 'max' | 'min', scope: EvaluationScope): number {
  let chosen: string | undefined;
  let best = kind === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const id of resolveSet(ref, scope)) {
    const value = noulValue(id, scope);
    if (value === undefined) return 0;
    if (kind === 'max' ? value > best : value < best) [chosen, best] = [id, value];
  }
  return chosen === undefined ? 1 : answerCertainty(chosen, scope);
}

function indicatorCertainty(name: string, scope: EvaluationScope): number {
  const indicator = scope.indicatorDefinitions?.get(name);
  if (indicator === undefined) return 0;
  if ('ponderado' in indicator) {
    const ids = Object.entries(indicator.ponderado).filter(([, weight]) => weight !== 0).map(([id]) => id);
    return Math.min(1, ...ids.map((id) => answerCertainty(id, scope)));
  }
  return 'max' in indicator ? extremeCertainty(indicator.max, 'max', scope) : extremeCertainty(indicator.min, 'min', scope);
}

/**
 * How sure the answers that settle a condition are, on the certainty scale of answers.ts. `todas`
 * true and `alguna` false need every branch, so the weakest counts; `todas` false and `alguna` true
 * need only one, so the surest deciding branch counts. A missing answer counts as 0.
 */
export function strength(condition: Condition, scope: EvaluationScope): number {
  if ('todas' in condition || 'alguna' in condition) {
    const children = 'todas' in condition ? condition.todas : condition.alguna;
    const decisive = 'alguna' in condition;
    const value = evaluate(condition, scope);
    if (value === null) return 0;
    if (value !== decisive) return Math.min(...children.map((child) => strength(child, scope)));
    return Math.max(...children.filter((child) => evaluate(child, scope) === decisive).map((child) => strength(child, scope)));
  }
  if ('no' in condition) return strength(condition.no, scope);
  if ('max' in condition) return extremeCertainty(condition.max, 'max', scope);
  if ('min' in condition) return extremeCertainty(condition.min, 'min', scope);
  if ('indicador' in condition) return indicatorCertainty(condition.indicador, scope);
  if ('p' in condition) return answerCertainty(resolvedId(condition.p, scope), scope);
  if ('eleccion' in condition) return answerCertainty(condition.eleccion, scope);
  if ('prob' in condition) return answerCertainty(condition.prob, scope);
  if ('normalizado' in condition) return answerCertainty(condition.normalizado, scope);
  return answerCertainty('confianza' in condition ? condition.confianza : 'prob_elegida' in condition ? condition.prob_elegida : condition.puntaje, scope);
}
