import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardia estática de sintaxis SQL:
 *
 * Valida que no se combinen cláusulas de bloqueo (`FOR SHARE` / `FOR UPDATE`)
 * con funciones de ventana, lo cual es inválido en PostgreSQL.
 */

const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** Los literales de plantilla que contienen SQL, uno por bloque de backticks. */
function sqlLiterals(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1] ?? '')
    .filter((literal) => /\bSELECT\b/i.test(literal));
}

function sourceFiles(dir: string = SOURCE_DIR): string[] {
  // Recursivo: el SQL vive tambien en src/repository/** desde la modularizacion.
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const ruta = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(ruta);
    return entry.name.endsWith('.ts') ? [ruta] : [];
  });
}

describe('cláusulas de bloqueo y funciones de ventana', () => {
  it('ninguna consulta con FOR SHARE/FOR UPDATE usa una función de ventana', () => {
    const ofensivas: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const literal of sqlLiterals(source)) {
        const bloquea = /\bFOR\s+(SHARE|UPDATE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i.test(literal);
        // `OVER (` sólo aparece en funciones de ventana; `OVER` como palabra suelta no existe en SQL.
        const ventana = /\bOVER\s*\(/i.test(literal);
        if (bloquea && ventana) {
          const primeraLinea = literal.trim().split('\n')[0] ?? '';
          ofensivas.push(`${file.split('/').pop()}: ${primeraLinea.slice(0, 120)}`);
        }
      }
    }

    expect(ofensivas, 'PostgreSQL rechaza esta combinación en tiempo de parseo').toEqual([]);
  });

  it('detecta el patrón prohibido cuando existe (la guardia sirve de algo)', () => {
    const ejemplo = 'SELECT id, COUNT(*) OVER () AS total FROM memberships FOR SHARE';
    const bloquea = /\bFOR\s+(SHARE|UPDATE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i.test(ejemplo);
    const ventana = /\bOVER\s*\(/i.test(ejemplo);
    expect(bloquea && ventana).toBe(true);
  });
});
