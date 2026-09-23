import type { JevAnswer } from '../src/answers.js';
import { certainty, parseJevResponse, signalView, validateThresholds, DEFAULT_THRESHOLDS } from '../src/answers.js';
import { DecisionError } from '../src/errors.js';
import { validateQuestions, validateState } from '../src/questions.js';
import {
  computeIndicator, evaluate, parseCondition, resolveTemplate,
  type Condition, type EvaluationScope, type References,
} from '../src/rules.js';

function scope(answers: Record<string, JevAnswer>, sets: Record<string, string[]> = {}, indicators: Record<string, number> = {}): EvaluationScope {
  return {
    answers: new Map(Object.entries(answers)),
    levels: new Map([['nivel', 5]]),
    indicators: new Map(Object.entries(indicators)),
    sets: (name) => sets[name] ?? [],
  };
}

function condition(value: unknown): Condition {
  const refs: References = { ids: [], sets: [], indicators: [] };
  return parseCondition(value, 'prueba', refs);
}

const noul = (p: number): JevAnswer => ({ type: 'noul', noul: p });
const choice = (winner: string, probabilities: Record<string, number>, confidence: number): JevAnswer => ({ type: 'choice', choice: winner, probabilities, confidence });

describe('lenguaje de reglas', () => {
  it('es trivalente: una respuesta ausente nunca dispara una regla, ni negada', () => {
    const vacio = scope({});
    expect(evaluate(condition({ p: 'x', '>=': 0.5 }), vacio)).toBeNull();
    expect(evaluate(condition({ no: { p: 'x', '>=': 0.5 } }), vacio)).toBeNull();
    const parcial = scope({ a: noul(0.9) });
    expect(evaluate(condition({ todas: [{ p: 'a', '>=': 0.5 }, { p: 'x', '>=': 0.5 }] }), parcial)).toBeNull();
    expect(evaluate(condition({ todas: [{ p: 'a', '<': 0.5 }, { p: 'x', '>=': 0.5 }] }), parcial)).toBe(false);
    expect(evaluate(condition({ alguna: [{ p: 'a', '>=': 0.5 }, { p: 'x', '>=': 0.5 }] }), parcial)).toBe(true);
  });

  it('compara con varios operadores a la vez para expresar franjas', () => {
    const franja = condition({ indicador: 'prioridad', '>=': 0.6, '<': 0.85 });
    expect(evaluate(franja, scope({}, {}, { prioridad: 0.7 }))).toBe(true);
    expect(evaluate(franja, scope({}, {}, { prioridad: 0.85 }))).toBe(false);
  });

  it('resuelve conjuntos por lista, por @nombre del alias y por prefijo', () => {
    const answers = { 'req::0': noul(0.9), 'req::1': noul(0.2), otro: noul(0.95) };
    expect(evaluate(condition({ min: 'req::*', '<=': 0.3 }), scope(answers))).toBe(true);
    expect(evaluate(condition({ max: ['req::0', 'otro'], '>=': 0.95 }), scope(answers))).toBe(true);
    expect(evaluate(condition({ max: '@politica', '>=': 0.3 }), scope(answers, { politica: ['req::1'] }))).toBe(false);
    expect(evaluate(condition({ max: '@politica', '>=': 0.3 }), scope(answers, { politica: ['otro'] }))).toBe(true);
    expect(evaluate(condition({ min: 'nada::*', '>=': 0.6 }), scope(answers))).toBe(true);
  });

  it('lee elecciones, probabilidades por opción y plantillas {eleccion:id}', () => {
    const answers = { destino: choice('kant', { kant: 0.8, zeus: 0.2 }, 0.7), 'encaja::kant': noul(0.6) };
    expect(evaluate(condition({ p: 'encaja::{eleccion:destino}', '>=': 0.5 }), scope(answers))).toBe(true);
    expect(evaluate(condition({ prob: 'destino', opcion: 'zeus', '>=': 0.2 }), scope(answers))).toBe(true);
    expect(evaluate(condition({ prob_elegida: 'destino', '>=': 0.8 }), scope(answers))).toBe(true);
    expect(evaluate(condition({ eleccion: 'destino', en: ['zeus', 'kant'] }), scope(answers))).toBe(true);
    expect(resolveTemplate('ruteá a {eleccion:destino}', new Map(Object.entries(answers)))).toBe('ruteá a kant');
    expect(resolveTemplate('{eleccion:falta}', new Map())).toBeUndefined();
  });

  it('pondera normalizando cada score por su nivel máximo', () => {
    const answers = { nivel: { type: 'score', score: 2, probabilities: { 2: 1 }, confidence: 1 } as JevAnswer, si: noul(1) };
    expect(computeIndicator({ ponderado: { nivel: 0.5, si: 0.5 } }, scope(answers))).toBeCloseTo(0.75);
    expect(computeIndicator({ ponderado: { nivel: 1, falta: 1 } }, scope(answers))).toBeUndefined();
  });

  it('rechaza condiciones mal formadas al cargar, no al decidir', () => {
    expect(() => condition({ p: 'x' })).toThrow(/comparador/u);
    expect(() => condition({ todas: [] })).toThrow(/no vacía/u);
    expect(() => condition({ eleccion: 'x', es: 'a', no_es: 'b' })).toThrow(/exactamente uno/u);
    expect(() => condition({ inventada: 'x', '>=': 1 })).toThrow(/desconocida/u);
  });
});

describe('preguntas y respuestas de Jev', () => {
  it('valida el formato de Jev antes de pagar una llamada', () => {
    expect(() => validateQuestions({ a: { type: 'choice', instructions: 'x', criteria: { sola: 'y' } } })).toThrow(/entre 2/u);
    expect(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: ['uno'] } })).toThrow(/niveles/u);
    expect(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_v, i) => String(i)) } })).toThrow(/niveles/u);
    expect(() => validateQuestions({ a: { type: 'noul', instructions: 'x', criteria: { quizas: 'y' } } })).toThrow(/true/u);
    expect(() => validateQuestions({ a: { type: 'noul', instructions: '  ' } })).toThrow(/vacío/u);
    expect(() => validateQuestions({ a: { type: 'noul', instructions: 'x', model: 'otro' } })).toThrow(/desconocido/u);
    expect(() => validateQuestions({ 'id con espacio': { type: 'noul', instructions: 'x' } })).toThrow(/no es válido/u);
    expect(() => validateQuestions(Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`q${String(i)}`, { type: 'noul', instructions: 'x' }])))).toThrow(/32/u);
    expect(() => validateState('x'.repeat(70_000))).toThrow(DecisionError);
    expect(() => validateState(42)).toThrow(/texto, un objeto o una lista/u);
  });

  it('rechaza respuestas que no coinciden con la pregunta', () => {
    const questions = validateQuestions({ c: { type: 'choice', instructions: 'x', criteria: { a: null, b: null } } });
    expect(() => parseJevResponse({ answers: { c: { type: 'choice', choice: 'z', confidence: 1, probabilities: {} } } }, questions)).toThrow(/c\.choice/u);
    expect(() => parseJevResponse({ answers: {} }, questions)).toThrow(/falta la respuesta/u);
    expect(() => parseJevResponse({ answers: { c: { type: 'noul', noul: 1 } } }, questions)).toThrow(/no coincide/u);
  });

  it('expresa la certeza en una sola escala y marca lo que no es firme', () => {
    expect(certainty(noul(0.9))).toBe(0.8);
    expect(certainty(noul(0.5))).toBe(0);
    expect(signalView(noul(0.5), 0, DEFAULT_THRESHOLDS)).toMatchObject({ respuesta: 'incierto', firme: false });
    expect(signalView(choice('a', { a: 0.55, b: 0.45 }, 0.1), 0, DEFAULT_THRESHOLDS)).toMatchObject({ eleccion: 'a', firme: false });
    expect(validateThresholds({ confianza: 0.9 }).confianza).toBe(0.9);
    expect(() => validateThresholds({ noul_si: 0.1, noul_no: 0.5 })).toThrow(/menor/u);
    expect(() => validateThresholds({ inventado: 0.1 })).toThrow(/no existe/u);
  });
});
