import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPANY_SLUG_PATTERN, RESERVED_COMPANY_SLUGS, configuredReservedCompanySlugs } from './company-slug.js';

describe('company slugs', () => {
  it('lists every reserved slug once and in the registration language', () => {
    expect(new Set(RESERVED_COMPANY_SLUGS).size).toBe(RESERVED_COMPANY_SLUGS.length);
    for (const slug of RESERVED_COMPANY_SLUGS) expect(slug).toMatch(COMPANY_SLUG_PATTERN);
    expect(RESERVED_COMPANY_SLUGS).toEqual(expect.arrayContaining(['admin', 'api', 'cauce', 'platform', 'root', 'support', 'www']));
  });

  it('adds the slugs the operator holds back and refuses a malformed list', () => {
    const reserved = configuredReservedCompanySlugs(' praxis, humanizar ,');
    expect(['praxis', 'humanizar', 'admin'].every(slug => reserved.has(slug))).toBe(true);
    expect(reserved.size).toBe(RESERVED_COMPANY_SLUGS.length + 2);
    expect(configuredReservedCompanySlugs('').size).toBe(RESERVED_COMPANY_SLUGS.length);
    for (const value of ['Praxis', 'praxis;humanizar', '-praxis']) {
      expect(() => configuredReservedCompanySlugs(value)).toThrow(/CAUCE_RESERVED_COMPANY_SLUGS/u);
    }
  });

  it('accepts exactly what the console form pattern accepts in a browser', () => {
    const source = readFileSync(new URL('../../../console/src/features/config/form-patterns.ts', import.meta.url), 'utf8');
    const html = /export const COMPANY_SLUG_PATTERN = '([^']+)';/u.exec(source)?.[1]?.replaceAll('\\\\', '\\');
    if (html === undefined) throw new Error('console COMPANY_SLUG_PATTERN is absent');
    const browser = new RegExp(`^(?:${html})$`, 'v');
    for (const sample of ['ab', 'acme', 'acme-1', 'a-b-c', 'a'.repeat(63), 'a', 'a'.repeat(64), 'acme_corp', 'Acme',
      '1acme', '-acme', 'acmé', 'ac me', '']) {
      expect(COMPANY_SLUG_PATTERN.test(sample), sample).toBe(browser.test(sample));
    }
  });
});
