import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const longDecimal = /(?<![0-9])[1-9][0-9]{8,18}(?![0-9])/u;

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

describe('tracked operational material does not inventory external identities', () => {
  it('keeps orphan diagnostics tenant-scoped and body-free', async () => {
    const cli = await source('ops/cli/cauce-huerfanas');
    expect(cli).toContain('m.tenant_id');
    expect(cli).not.toMatch(/CASE\s+m\.origin->>'conversation_id'/u);
    expect(cli).toContain("char_length(coalesce(m.body->>'text', ''))");
    expect(cli).not.toMatch(/\bAS\s+pedido\b/u);
    expect(cli).not.toMatch(longDecimal);

    const compatibility = await source('ops/guardias/cauce-huerfanas.sh');
    expect(compatibility).toContain('../cli/cauce-huerfanas');
    expect(compatibility).not.toContain('SELECT');
  });

  it('keeps direct-channel identities out of runbooks, mocks and scheduled prompts', async () => {
    for (const path of [
      'ops/guardias/hegel-ventas-checkin.py',
      'console/src/features/config/ConfigPage.tsx',
    ]) {
      expect(await source(path), path).not.toMatch(longDecimal);
    }
  });

  // ── NEGATIVE CONTROL: el regex `longDecimal` se usa para asegurar AUSENCIA de decimales
  //    largos en paths donde no deben aparecer. Si el regex midiera siempre vacío, los
  //    `not.toMatch` de arriba pasarían por las buenas aunque los paths trajeran un ID
  //    numérico. Comprobamos que el detector sí se dispara contra entradas positivas.
  it('CONTROL NEGATIVO — el detector de decimales largos sí reacciona contra números construidos a propósito', () => {
    expect('+5491131234567').toMatch(longDecimal);
    expect('1234567890123456789').toMatch(longDecimal);
  });
});
