import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Identifiers of the first two companies. They live in data now; code must not carry them as values. */
const COMPANY_LITERAL = /(?<![A-Za-z0-9_])(?:Steven|Hospital|humanizar|praxis|steven_dm|grp\.steven|grp\.hospital|argos|zeus|kant)(?![A-Za-z0-9_])/u;
/** The Spanish word for "operator" is only a company literal as the whole value. */
const EXACT_LITERALS = new Set(['operador']);
/** Wire vocabulary shared with its emitter; it names a message type, not a company. */
const ALLOWED_VALUES = new Set(['praxis.supervision.notice']);

/**
 * Development and test scaffolding legitimately names the fixture companies. This is a classification
 * of files, not a debt list.
 */
const SCAFFOLDING = /(?:\.test\.|fixtures?|test-support|test-utils|test-helpers|(?:^|\/)(?:mocks|test|tests|__tests__|node_modules|dist)\/)/u;
const SCAFFOLDING_FILES = new Set(['packages/store/src/seed-dev-cli.ts']);

function* productionFiles(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = relative(repository, path).split('\\').join('/');
    if (SCAFFOLDING.test(`/${rel}`) || SCAFFOLDING.test(`${rel}/`)) continue;
    if (statSync(path).isDirectory()) yield* productionFiles(path);
    else if (/\.(?:ts|tsx)$/u.test(name) && !SCAFFOLDING_FILES.has(rel)) yield rel;
  }
}

function sourceRoots(): string[] {
  const roots = ['console/src'];
  for (const group of ['packages', 'services']) {
    for (const name of readdirSync(join(repository, group))) {
      const root = join(group, name, 'src');
      if (statSync(join(repository, group, name)).isDirectory() && existsDirectory(join(repository, root))) roots.push(root);
    }
  }
  return roots;
}

function existsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Every string a file embeds as a value; comments, imports and exports are not values. */
function literalsOf(file: string, text: string): { line: number; value: string }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { line: number; value: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, value: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function companyLiteralsIn(file: string, text: string): string[] {
  return literalsOf(file, text)
    .filter(({ value }) => !ALLOWED_VALUES.has(value) && (EXACT_LITERALS.has(value) || COMPANY_LITERAL.test(value)))
    .map(({ line, value }) => `${file}:${String(line)} ${JSON.stringify(value.slice(0, 40))}`);
}

describe('company literals live in data, not in code', () => {
  test('production sources hold no company literals', () => {
    const violations: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of productionFiles(join(repository, root))) {
        violations.push(...companyLiteralsIn(file, readFileSync(join(repository, file), 'utf8')));
      }
    }
    expect(violations).toEqual([]);
  });

  test('the scanner sees values and ignores comments, imports and look-alike words', () => {
    const sample = [
      "import { x } from './zeus-client.js';",
      '// kant argos Hospital in a comment',
      "const a = 'Steven'; const b = `grp.hospital/${a}`; const c = 'kantian'; const d = 'operador';",
      "const e = 'el operador del turno'; const f = 'praxis.supervision.notice';",
    ].join('\n');
    expect(companyLiteralsIn('sample.ts', sample).map((entry) => entry.split(' ')[1])).toEqual(['"Steven"', '"grp.hospital/"', '"operador"']);
  });
});
