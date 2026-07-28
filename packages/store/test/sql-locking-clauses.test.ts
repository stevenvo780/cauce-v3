import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardia de contrato SQL, sin base de datos.
 *
 * PostgreSQL rechaza `FOR SHARE`/`FOR UPDATE` en la misma consulta que una función de ventana:
 * "FOR SHARE is not allowed with window functions". El rechazo es de PARSEO, así que la consulta
 * no falla con ciertos datos: falla siempre, y sólo se descubre cuando el camino se ejecuta de
 * verdad en producción. El 2026-07-26 una consulta así en `materializeAgentResponse` abortó la
 * transacción del tick del reaper 99.241 veces en 24 h y dejó 46 entregas atascadas en `started`;
 * ningún test la vio porque los tests del store que la habrían ejercido necesitan Postgres real.
 *
 * Esta guardia es barata y corre en cualquier lado: lee el SQL del propio código fuente.
 */

const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** Los literales de plantilla que contienen SQL, uno por bloque de backticks. */
function sqlLiterals(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1] ?? '')
    .filter((literal) => /\bSELECT\b/i.test(literal));
}

function sourceFiles(): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SOURCE_DIR, name));
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
