import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invalid } from './errors.js';
import {
  assertJsonValue, criteriaOptions, isPlainObject, levelMap, validateQuestion, validateQuestions,
  type JevQuestion, type JevQuestions, type JsonValue, type QuestionType,
} from './questions.js';
import {
  hasTemplate, parseCondition, parseIndicator, type Condition, type Indicator, type References, type SetRef,
} from './rules.js';

export interface Outcome {
  readonly decision: string;
  readonly valor?: string;
  readonly motivo: string;
  readonly llm: boolean;
}

export interface Rule { readonly si: Condition; readonly entonces: Outcome }

export interface Prefilter {
  readonly campos: readonly string[];
  readonly patron: RegExp;
  readonly soloAlias?: readonly string[];
  readonly exceptoAlias?: readonly string[];
  readonly entonces: Outcome;
}

interface ExpansionBase { readonly source: string; readonly id: string; readonly template: JsonValue; readonly type: QuestionType }
type Expansion =
  | (ExpansionBase & { readonly kind: 'opcion'; readonly except: readonly string[] })
  | (ExpansionBase & { readonly kind: 'elemento'; readonly min: number; readonly max: number });

interface Restriction { readonly fixed: readonly string[]; readonly min: number }
interface NamedSet { readonly defecto: readonly string[]; readonly porAlias: Readonly<Record<string, readonly string[]>> }

export interface Plantilla {
  readonly id: string;
  readonly version: string;
  /** Why this template stays off until an operator enables it explicitly (data leaving the fleet). */
  readonly requiresEnablement: string | undefined;
  readonly questions: JevQuestions;
  readonly stateRequerido: readonly string[];
  readonly expansions: readonly Expansion[];
  readonly restrictions: ReadonlyMap<string, Restriction>;
  readonly sets: ReadonlyMap<string, NamedSet>;
  readonly indicators: ReadonlyMap<string, Indicator>;
  readonly prefilters: readonly Prefilter[];
  readonly rules: readonly Rule[];
  readonly sino: Outcome;
  readonly siFalla: Outcome;
  readonly marks: ReadonlyMap<string, Condition>;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface Catalog {
  readonly version: string;
  readonly calibratedModel: string;
  readonly plantillas: ReadonlyMap<string, Plantilla>;
}

const ID = /^[a-z][a-z0-9_]{1,63}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const TOP_LEVEL = new Set([
  'id', 'version', 'nombre', 'cuando_usar', 'requiere_habilitacion', 'state', 'state_requerido', 'questions', 'expansiones', 'restricciones',
  'conjuntos', 'indicadores', 'prefiltros', 'reglas', 'sino', 'si_falla', 'marcas', 'notas', 'evidencia',
]);

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fail(path, 'debe ser texto no vacío');
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return fail(path, 'debe ser una lista de texto');
  return value as string[];
}

function parseOutcome(value: unknown, path: string, templatesAllowed: boolean): Outcome {
  if (!isPlainObject(value)) return fail(path, 'un resultado es {decision, motivo, valor?, llm?}');
  const extra = Object.keys(value).find((key) => !['decision', 'valor', 'motivo', 'llm'].includes(key));
  if (extra !== undefined) fail(path, `campo inesperado '${extra}'`);
  const decision = text(value.decision, `${path}.decision`);
  const valor = value.valor === undefined ? undefined : text(value.valor, `${path}.valor`);
  if (value.llm !== undefined && typeof value.llm !== 'boolean') fail(`${path}.llm`, 'es booleano');
  if (!templatesAllowed && (hasTemplate(decision) || (valor !== undefined && hasTemplate(valor)))) {
    fail(path, 'si_falla no puede depender de una respuesta de Jev');
  }
  return { decision, motivo: text(value.motivo, `${path}.motivo`), llm: value.llm === true, ...(valor === undefined ? {} : { valor }) };
}

/** Substitutes `{opcion}`, `{i}` and `{criterio.<campo>}` in every string of an expansion's question. */
function substitute(value: JsonValue, variables: Readonly<Record<string, string>>): JsonValue {
  if (typeof value === 'string') return value.replace(/\{(opcion|i|criterio(?:\.[a-z_]+)?)\}/gu, (match, name: string) => variables[name] ?? match);
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, variables)]));
  return value;
}

function criterionVariables(criterion: JsonValue | undefined): Record<string, string> {
  if (typeof criterion === 'string') return { criterio: criterion };
  if (!isPlainObject(criterion)) return {};
  const variables: Record<string, string> = { criterio: JSON.stringify(criterion) };
  for (const [key, value] of Object.entries(criterion)) if (typeof value === 'string') variables[`criterio.${key}`] = value;
  return variables;
}

function prefixOf(template: string): string {
  const cut = template.indexOf('{');
  return cut === -1 ? template : template.slice(0, cut);
}

function parseExpansion(value: unknown, path: string, questions: JevQuestions): Expansion {
  if (!isPlainObject(value)) return fail(path, 'una expansión es un objeto');
  const id = text(value.id, `${path}.id`);
  if (!id.includes('{') || prefixOf(id).length === 0) fail(`${path}.id`, 'debe empezar con un prefijo fijo y llevar {opcion} o {i}');
  assertJsonValue(value.pregunta, `${path}.pregunta`);
  const template = value.pregunta;
  const { type } = validateQuestion(`${prefixOf(id)}x`, substitute(template, { opcion: 'x', i: '0', criterio: 'x' }));
  if ('por_opcion' in value) {
    const source = text(value.por_opcion, `${path}.por_opcion`);
    if (questions[source]?.type !== 'choice') fail(`${path}.por_opcion`, `'${source}' no es un choice de la plantilla`);
    const except = value.excepto === undefined ? [] : strings(value.excepto, `${path}.excepto`);
    return { kind: 'opcion', source, except, id, template, type };
  }
  const source = text(value.por_elemento, `${path}.por_elemento`);
  const min = typeof value.minimo === 'number' ? value.minimo : 1;
  const max = typeof value.maximo === 'number' ? value.maximo : 20;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 30) fail(path, 'minimo/maximo inválidos');
  return { kind: 'elemento', source, min, max, id, template, type };
}

function typeIndex(questions: JevQuestions, expansions: readonly Expansion[]): (id: string) => QuestionType | undefined {
  return (id) => {
    const direct = questions[id]?.type;
    if (direct !== undefined) return direct;
    return expansions.find((entry) => id.startsWith(prefixOf(entry.id)))?.type;
  };
}

function checkReferences(refs: References, typeOf: (id: string) => QuestionType | undefined, sets: ReadonlyMap<string, NamedSet>, indicators: ReadonlySet<string>, path: string): void {
  for (const id of refs.ids) if (typeOf(id) === undefined) fail(path, `referencia a una pregunta inexistente '${id}'`);
  for (const name of refs.indicators) if (!indicators.has(name)) fail(path, `referencia a un indicador inexistente '${name}'`);
  const checkSet = (ref: SetRef): void => {
    if (typeof ref !== 'string') {
      for (const id of ref) if (typeOf(id) !== 'noul') fail(path, `'${id}' no es un noul de la plantilla`);
    } else if (ref.startsWith('@')) {
      if (!sets.has(ref.slice(1))) fail(path, `conjunto inexistente '${ref}'`);
    } else if (typeOf(ref.endsWith('*') ? ref.slice(0, -1) : ref) !== 'noul') {
      fail(path, `'${ref}' no nombra nouls de la plantilla`);
    }
  };
  refs.sets.forEach(checkSet);
}

export function parsePlantilla(raw: unknown, source: string): Plantilla {
  if (!isPlainObject(raw)) return fail(source, 'la plantilla es un objeto');
  const extra = Object.keys(raw).find((key) => !TOP_LEVEL.has(key));
  if (extra !== undefined) fail(source, `campo desconocido '${extra}'`);
  const id = text(raw.id, `${source}.id`);
  if (!ID.test(id)) fail(`${source}.id`, 'debe ser minúsculas, dígitos y _');
  const version = text(raw.version, `${source}.version`);
  if (!SEMVER.test(version)) fail(`${source}.version`, 'debe ser semver X.Y.Z');
  text(raw.nombre, `${source}.nombre`);
  text(raw.cuando_usar, `${source}.cuando_usar`);
  const questions = validateQuestions(raw.questions);
  const expansionsRaw = raw.expansiones === undefined ? [] : raw.expansiones;
  if (!Array.isArray(expansionsRaw)) fail(`${source}.expansiones`, 'es una lista');
  const expansions = expansionsRaw.map((entry, index) => parseExpansion(entry, `${source}.expansiones[${String(index)}]`, questions));
  const typeOf = typeIndex(questions, expansions);

  const restrictions = new Map<string, Restriction>();
  for (const [qid, entry] of Object.entries(isPlainObject(raw.restricciones) ? raw.restricciones : {})) {
    if (questions[qid]?.type !== 'choice' || !isPlainObject(entry)) fail(`${source}.restricciones.${qid}`, 'sólo se restringen choices');
    const fixed = entry.fijas === undefined ? [] : strings(entry.fijas, `${source}.restricciones.${qid}.fijas`);
    const options = criteriaOptions(questions[qid]);
    if (fixed.some((option) => !options.includes(option))) fail(`${source}.restricciones.${qid}.fijas`, 'opción inexistente');
    restrictions.set(qid, { fixed, min: typeof entry.minimo === 'number' ? Math.max(2, entry.minimo) : 2 });
  }

  const sets = new Map<string, NamedSet>();
  for (const [name, entry] of Object.entries(isPlainObject(raw.conjuntos) ? raw.conjuntos : {})) {
    if (!isPlainObject(entry)) return fail(`${source}.conjuntos.${name}`, 'es {defecto, por_alias?}');
    const porAlias: Record<string, string[]> = {};
    for (const [alias, ids] of Object.entries(isPlainObject(entry.por_alias) ? entry.por_alias : {})) porAlias[alias] = strings(ids, `${source}.conjuntos.${name}.por_alias.${alias}`);
    const defecto = strings(entry.defecto, `${source}.conjuntos.${name}.defecto`);
    for (const qid of [...defecto, ...Object.values(porAlias).flat()]) if (typeOf(qid) !== 'noul') fail(`${source}.conjuntos.${name}`, `'${qid}' no es un noul`);
    sets.set(name, { defecto, porAlias });
  }

  const refs: References = { ids: [], sets: [], indicators: [] };
  const indicators = new Map<string, Indicator>();
  for (const [name, entry] of Object.entries(isPlainObject(raw.indicadores) ? raw.indicadores : {})) {
    indicators.set(name, parseIndicator(entry, `${source}.indicadores.${name}`, refs));
  }
  if (!Array.isArray(raw.reglas)) fail(`${source}.reglas`, 'es una lista');
  const rules = raw.reglas.map((entry: unknown, index: number): Rule => {
    const path = `${source}.reglas[${String(index)}]`;
    if (!isPlainObject(entry)) return fail(path, 'una regla es {si, entonces}');
    return { si: parseCondition(entry.si, `${path}.si`, refs), entonces: parseOutcome(entry.entonces, `${path}.entonces`, true) };
  });
  const marks = new Map<string, Condition>();
  for (const [name, entry] of Object.entries(isPlainObject(raw.marcas) ? raw.marcas : {})) marks.set(name, parseCondition(entry, `${source}.marcas.${name}`, refs));
  const templated = refs.ids.filter(hasTemplate);
  refs.ids.splice(0, refs.ids.length, ...refs.ids.filter((qid) => !hasTemplate(qid)), ...templated.map((qid) => prefixOf(qid)));
  checkReferences(refs, typeOf, sets, new Set(indicators.keys()), source);

  const prefiltersRaw = raw.prefiltros === undefined ? [] : raw.prefiltros;
  if (!Array.isArray(prefiltersRaw)) fail(`${source}.prefiltros`, 'es una lista');
  const prefilters = prefiltersRaw.map((entry: unknown, index: number): Prefilter => {
    const path = `${source}.prefiltros[${String(index)}]`;
    if (!isPlainObject(entry)) return fail(path, 'un prefiltro es {campos, patron, entonces}');
    const flags = entry.flags === undefined ? 'u' : `${text(entry.flags, `${path}.flags`)}u`;
    if (!/^[ims]*u$/u.test(flags)) fail(`${path}.flags`, 'sólo i, m, s');
    let patron: RegExp;
    try {
      patron = new RegExp(text(entry.patron, `${path}.patron`), flags);
    } catch (error) {
      return fail(`${path}.patron`, error instanceof Error ? error.message : 'expresión inválida');
    }
    return {
      campos: strings(entry.campos, `${path}.campos`),
      patron,
      entonces: parseOutcome(entry.entonces, `${path}.entonces`, false),
      ...(entry.solo_alias === undefined ? {} : { soloAlias: strings(entry.solo_alias, `${path}.solo_alias`) }),
      ...(entry.excepto_alias === undefined ? {} : { exceptoAlias: strings(entry.excepto_alias, `${path}.excepto_alias`) }),
    };
  });

  return {
    id, version, questions,
    requiresEnablement: raw.requiere_habilitacion === undefined ? undefined : text(raw.requiere_habilitacion, `${source}.requiere_habilitacion`),
    stateRequerido: raw.state_requerido === undefined ? [] : strings(raw.state_requerido, `${source}.state_requerido`),
    expansions, restrictions, sets, indicators, prefilters, rules, marks,
    sino: parseOutcome(raw.sino, `${source}.sino`, true),
    siFalla: parseOutcome(raw.si_falla, `${source}.si_falla`, false),
    definition: raw,
  };
}

export async function loadCatalog(directory: string): Promise<Catalog> {
  const index = JSON.parse(await readFile(join(directory, 'catalogo.json'), 'utf8')) as unknown;
  if (!isPlainObject(index)) throw new Error('catalogo.json debe ser un objeto');
  const version = text(index.version, 'catalogo.json.version');
  if (!SEMVER.test(version)) throw new Error('catalogo.json.version debe ser semver');
  const plantillas = new Map<string, Plantilla>();
  const files = (await readdir(join(directory, 'plantillas'))).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const plantilla = parsePlantilla(JSON.parse(await readFile(join(directory, 'plantillas', file), 'utf8')), file);
    if (`${plantilla.id}.json` !== file) throw new Error(`${file}: el id '${plantilla.id}' no coincide con el nombre del fichero`);
    plantillas.set(plantilla.id, plantilla);
  }
  if (plantillas.size === 0) throw new Error('el catálogo no tiene plantillas');
  return { version, calibratedModel: text(index.modelo_calibrado, 'catalogo.json.modelo_calibrado'), plantillas };
}

function readPath(state: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = state;
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function fieldText(state: JsonValue, path: string): string | undefined {
  const value = readPath(state, path);
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface Expanded {
  readonly questions: JevQuestions;
  readonly levels: ReadonlyMap<string, number>;
}

function restrict(plantilla: Plantilla, restringir: unknown): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = { ...plantilla.questions };
  if (restringir === undefined) return questions;
  if (!isPlainObject(restringir)) throw invalid('opciones.restringir mapea pregunta → opciones permitidas');
  for (const [qid, allowed] of Object.entries(restringir)) {
    const restriction = plantilla.restrictions.get(qid);
    const question = plantilla.questions[qid];
    if (restriction === undefined || question === undefined) throw invalid(`la pregunta '${qid.slice(0, 40)}' no admite restricción`);
    if (!Array.isArray(allowed) || allowed.some((option) => typeof option !== 'string')) throw invalid(`opciones.restringir.${qid} es una lista de opciones`);
    const options = criteriaOptions(question);
    const unknown = (allowed as string[]).find((option) => !options.includes(option));
    if (unknown !== undefined) throw invalid(`'${unknown.slice(0, 40)}' no es una opción de ${qid}`);
    const keep = options.filter((option) => (allowed as string[]).includes(option) || restriction.fixed.includes(option));
    if (keep.length < restriction.min) throw invalid(`${qid} necesita al menos ${String(restriction.min)} opciones tras restringir`);
    const criteria = question.criteria as Record<string, JsonValue>;
    questions[qid] = { ...question, criteria: Object.fromEntries(keep.map((option) => [option, criteria[option] ?? null])) };
  }
  return questions;
}

/** The questions actually sent for one request: restrictions applied, then expansions instantiated. */
export function expandQuestions(plantilla: Plantilla, state: JsonValue, restringir: unknown): Expanded {
  const questions = restrict(plantilla, restringir);
  for (const expansion of plantilla.expansions) {
    const make = (variables: Record<string, string>): JevQuestion =>
      validateQuestion(substitute(expansion.id, variables) as string, substitute(expansion.template, variables));
    if (expansion.kind === 'opcion') {
      const choice = questions[expansion.source];
      const criteria = (choice?.criteria ?? {}) as Record<string, JsonValue>;
      for (const option of Object.keys(criteria).filter((entry) => !expansion.except.includes(entry))) {
        const variables = { opcion: option, ...criterionVariables(criteria[option]) };
        questions[substitute(expansion.id, variables) as string] = make(variables);
      }
      continue;
    }
    const items = readPath(state, expansion.source);
    if (!Array.isArray(items) || items.length < expansion.min || items.length > expansion.max) {
      throw invalid(`state.${expansion.source} debe ser una lista de ${String(expansion.min)} a ${String(expansion.max)} elementos`);
    }
    items.forEach((_item, index) => {
      const variables = { i: String(index) };
      questions[substitute(expansion.id, variables) as string] = make(variables);
    });
  }
  if (Object.keys(questions).length > 32) throw invalid('la plantilla expandida supera 32 preguntas');
  return { questions, levels: levelMap(questions) };
}

export function setResolver(plantilla: Plantilla, alias: string): (name: string) => readonly string[] {
  return (name) => {
    const entry = plantilla.sets.get(name);
    return entry === undefined ? [] : (entry.porAlias[alias] ?? entry.defecto);
  };
}

function possibleDecisions(plantilla: Plantilla): string[] {
  const outcomes = [...plantilla.prefilters.map((entry) => entry.entonces), ...plantilla.rules.map((rule) => rule.entonces), plantilla.sino, plantilla.siFalla];
  const decisions = new Set<string>();
  for (const { decision } of outcomes) {
    const templated = /^\{eleccion:([^{}]+)\}$/u.exec(decision);
    const choice = templated?.[1] === undefined ? undefined : plantilla.questions[templated[1]];
    if (choice === undefined) decisions.add(decision);
    else for (const option of criteriaOptions(choice)) decisions.add(option);
  }
  return [...decisions];
}

export function summary(plantilla: Plantilla, enabled: boolean): Record<string, unknown> {
  return {
    id: plantilla.id,
    version: plantilla.version,
    nombre: plantilla.definition.nombre,
    cuando_usar: plantilla.definition.cuando_usar,
    state: plantilla.definition.state,
    state_requerido: plantilla.stateRequerido,
    decisiones: possibleDecisions(plantilla),
    habilitada: enabled,
    ...(plantilla.requiresEnablement === undefined ? {} : { requiere_habilitacion: plantilla.requiresEnablement }),
    restringible: Object.fromEntries([...plantilla.restrictions.keys()].map((qid) => [qid, criteriaOptions(plantilla.questions[qid] ?? { type: 'noul', instructions: '' })])),
  };
}
