import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_ALIAS_PATTERN, COMPANY_SLUG_PATTERN, companyHostIdPattern, HOST_ID_PATTERN } from './form-patterns';

const srcRoot = join(import.meta.dirname, '..', '..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/u.test(name) && !/\.test\.tsx$/u.test(name) ? [path] : [];
  });
}
const compiles = (pattern: string) => new RegExp(`^(?:${pattern})$`, 'v');

it('cada pattern declarado compila con el flag v que aplican los navegadores', () => {
  for (const pattern of [COMPANY_SLUG_PATTERN, AGENT_ALIAS_PATTERN, HOST_ID_PATTERN, companyHostIdPattern('acme-corp'), companyHostIdPattern('one')]) {
    expect(() => compiles(pattern), pattern).not.toThrow();
  }
});
it('ningún pattern literal de los formularios queda sin validar con el flag v', () => {
  const found: string[] = [];
  for (const file of sources(srcRoot)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bpattern="([^"]*)"/gu)) found.push(match[1] ?? '');
  }
  for (const pattern of found) expect(() => compiles(pattern), pattern).not.toThrow();
});
it('los patterns aceptan y rechazan lo mismo que antes', () => {
  expect(compiles(COMPANY_SLUG_PATTERN).test('acme-corp')).toBe(true);
  expect(compiles(COMPANY_SLUG_PATTERN).test('a')).toBe(false);
  expect(compiles(COMPANY_SLUG_PATTERN).test('Acme')).toBe(false);
  expect(compiles(AGENT_ALIAS_PATTERN).test('worker_1-b')).toBe(true);
  expect(compiles(AGENT_ALIAS_PATTERN).test('1worker')).toBe(false);
  expect(compiles(companyHostIdPattern('acme-corp')).test('acme-corp-torre_1')).toBe(true);
  expect(compiles(companyHostIdPattern('acme-corp')).test('acme-corp-torre-1')).toBe(false);
  expect(compiles(companyHostIdPattern('acme')).test('otra-torre')).toBe(false);
});
