import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface TestCaseReference {
  file: string;
  name: string;
}

interface ChannelCrudCell {
  tests?: TestCaseReference[];
  pendiente?: string;
}

type CrudChannel = 'consola' | 'api' | 'cli';
type CrudOperation = 'crear' | 'consultar' | 'editar' | 'eliminar';
type MandatoryEntity =
  | 'agentes'
  | 'ordenadores'
  | 'personas'
  | 'entornos_de_cuota'
  | 'contextos'
  | 'salas'
  | 'espacios'
  | 'empresas';

type OperationChannels = Record<CrudChannel, ChannelCrudCell>;
type EntityOperations = Record<CrudOperation, OperationChannels>;

interface V4CrudEntityRecord {
  label: string;
  operaciones: EntityOperations;
}

interface V4CrudMatrixDocument {
  schema_version: number;
  entidades?: Record<MandatoryEntity, V4CrudEntityRecord>;
}

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const mandatoryEntities: readonly MandatoryEntity[] = [
  'agentes',
  'ordenadores',
  'personas',
  'entornos_de_cuota',
  'contextos',
  'salas',
  'espacios',
  'empresas',
];
const mandatoryOperations: readonly CrudOperation[] = ['crear', 'consultar', 'editar', 'eliminar'];
const mandatoryChannels: readonly CrudChannel[] = ['consola', 'api', 'cli'];
const sourceCache = new Map<string, string>();
let matrix: V4CrudMatrixDocument;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function declaresTestCase(sourceText: string, file: string, testName: string): boolean {
  const escaped = escapeRegExp(testName);
  if (file.endsWith('.py')) {
    return new RegExp(`\\bdef\\s+${escaped}\\s*\\(`, 'u').test(sourceText);
  }
  return new RegExp(
    `\\b(?:it|test|scenario)(?:\\.[\\w$]+(?:\\([^)]*\\))?)*\\s*\\(\\s*['"\`]${escaped}['"\`]`,
    'u',
  ).test(sourceText);
}

async function readTestSource(file: string): Promise<string> {
  const absolute = resolve(projectRoot, file);
  const local = relative(projectRoot, absolute);
  if (
    local.startsWith('..')
    || local !== file
    || !/^(?:tests|console|services|packages|ops\/tests)\//u.test(file)
  ) {
    throw new Error(`Invalid test reference path: ${file}`);
  }
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const content = await readFile(absolute, 'utf8');
  sourceCache.set(file, content);
  return content;
}

export async function validateV4CrudMatrix(candidate: V4CrudMatrixDocument): Promise<string[]> {
  const errors: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) errors.push(message);
  };

  check(candidate.schema_version === 1, 'Unsupported schema_version');
  const entidades = candidate.entidades;
  if (!entidades || typeof entidades !== 'object') {
    errors.push('Missing entidades map in docs/v4-matriz-crud.json');
    return errors;
  }

  for (const entity of mandatoryEntities) {
    const entry = (entidades as Partial<Record<MandatoryEntity, V4CrudEntityRecord>>)[entity];
    if (!entry || typeof entry !== 'object') {
      errors.push(`Missing mandatory entity: ${entity}`);
      continue;
    }
    check(typeof entry.label === 'string' && entry.label.trim() !== '', `Empty label for entity: ${entity}`);
    const operations = entry.operaciones as Partial<Record<CrudOperation, OperationChannels>> | undefined;
    if (!operations || typeof operations !== 'object') {
      errors.push(`Missing operaciones map for entity: ${entity}`);
      continue;
    }
    check(
      Object.keys(operations).sort().join(',') === [...mandatoryOperations].sort().join(','),
      `Entity ${entity} must declare exact operations crear,consultar,editar,eliminar`,
    );

    for (const operation of mandatoryOperations) {
      const channels = operations[operation];
      const operationId = `${entity}.${operation}`;
      if (!channels || typeof channels !== 'object') {
        errors.push(`Missing mandatory operation: ${operationId}`);
        continue;
      }
      check(
        Object.keys(channels).sort().join(',') === [...mandatoryChannels].sort().join(','),
        `Operation ${operationId} must declare exact channels consola,api,cli`,
      );

      for (const channel of mandatoryChannels) {
        const cell = (channels as Partial<Record<CrudChannel, ChannelCrudCell>>)[channel];
        const cellId = `${operationId}.${channel}`;
        if (!cell || typeof cell !== 'object') {
          errors.push(`Missing mandatory cell: ${cellId}`);
          continue;
        }

        const tests = cell.tests ?? [];
        const hasTests = tests.length > 0;
        const hasPendingReason = typeof cell.pendiente === 'string' && cell.pendiente.trim() !== '';

        if (cell.pendiente !== undefined && !hasPendingReason) {
          errors.push(`Empty pendiente reason in cell: ${cellId}`);
        }
        if (!hasTests && !hasPendingReason) {
          errors.push(`Mandatory cell is empty without explicit pendiente reason: ${cellId}`);
        }

        for (const reference of tests) {
          if (reference.file.trim() === '' || reference.name.trim() === '') {
            errors.push(`Empty test file or test case name in cell: ${cellId}`);
            continue;
          }
          try {
            const content = await readTestSource(reference.file);
            check(
              declaresTestCase(content, reference.file, reference.name),
              `Missing test case in ${cellId}: ${reference.file} :: ${reference.name}`,
            );
          } catch (error) {
            errors.push(
              `Missing test file in ${cellId}: ${reference.file} (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
      }
    }
  }

  return errors;
}

beforeAll(async () => {
  const matrixPath = process.env.CAUCE_CRUD_MATRIX_FILE ?? resolve(projectRoot, 'docs/v4-matriz-crud.json');
  matrix = JSON.parse(await readFile(matrixPath, 'utf8')) as V4CrudMatrixDocument;
});

describe('V4 machine-verifiable CRUD matrix by entity, operation and channel', () => {
  it('verifies every mandatory entity, operation and channel against real test files and cases', async () => {
    expect(await validateV4CrudMatrix(matrix)).toEqual([]);
  });

  it('fails when a referenced test file does not exist', async () => {
    const damaged = structuredClone(matrix);
    const cell = damaged.entidades?.agentes.operaciones.crear.consola;
    if (!cell) throw new Error('Missing agentes.crear.consola cell');
    cell.tests = [{ file: 'tests/e2e/zz-nonexistent-crud-file.test.ts', name: 'nonexistent case' }];
    const errors = await validateV4CrudMatrix(damaged);
    expect(errors.some(error => error.includes('Missing test file in agentes.crear.consola: tests/e2e/zz-nonexistent-crud-file.test.ts'))).toBe(true);
  });

  it('fails when a referenced test file does not contain the exact test case name', async () => {
    const damaged = structuredClone(matrix);
    const cell = damaged.entidades?.agentes.operaciones.crear.consola;
    const firstTest = cell?.tests?.[0];
    if (!cell || !firstTest) throw new Error('Missing agentes.crear.consola test reference');
    cell.tests = [{ file: firstTest.file, name: `${firstTest.name} [caso-inexistente]` }];
    const errors = await validateV4CrudMatrix(damaged);
    expect(errors).toContain(
      `Missing test case in agentes.crear.consola: ${firstTest.file} :: ${firstTest.name} [caso-inexistente]`,
    );
  });

  it('fails when a mandatory cell is empty without an explicit pendiente reason', async () => {
    const damaged = structuredClone(matrix);
    if (!damaged.entidades) throw new Error('Missing entidades map');
    damaged.entidades.personas.operaciones.eliminar.cli = { tests: [] };
    const errors = await validateV4CrudMatrix(damaged);
    expect(errors).toContain('Mandatory cell is empty without explicit pendiente reason: personas.eliminar.cli');
  });

  it('fails when a mandatory cell declares an empty pendiente string', async () => {
    const damaged = structuredClone(matrix);
    if (!damaged.entidades) throw new Error('Missing entidades map');
    damaged.entidades.ordenadores.operaciones.eliminar.cli = { pendiente: '   ' };
    const errors = await validateV4CrudMatrix(damaged);
    expect(errors).toContain('Empty pendiente reason in cell: ordenadores.eliminar.cli');
    expect(errors).toContain('Mandatory cell is empty without explicit pendiente reason: ordenadores.eliminar.cli');
  });
});
