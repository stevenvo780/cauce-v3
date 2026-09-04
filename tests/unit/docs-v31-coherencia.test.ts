import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('../../', import.meta.url));

const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: raiz,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe']
  });

const existeEnCommit = (commit: string, ruta: string): boolean => {
  try {
    git('cat-file', '-e', `${commit}:${ruta}`);
    return true;
  } catch {
    return false;
  }
};

const leer = (ruta: string): string => readFileSync(new URL(ruta, new URL(raiz, 'file:')), 'utf8');

const pendientes = (): string => leer('docs/v3.1-pendientes.md');
const version = (): string => leer('docs/version-3.1.md');
const historial = (): string => leer('deploy/HISTORIAL.md');

const ultimaFilaDeHistorial = (): { commit: string; resultado: string } => {
  const filas = historial()
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => /^\|\s*\d{8}T\d{6}Z\s*\|/u.test(linea));
  const ultima = filas.at(-1) ?? '';
  expect(ultima, 'deploy/HISTORIAL.md debe tener al menos una fila de despliegue').not.toBe('');
  const columnas = ultima.split('|').map((columna) => columna.trim());
  const commit = columnas[2] ?? '';
  expect(commit, 'la fila de despliegue debe traer un commit').toMatch(/^[0-9a-f]{7,40}$/u);
  return { commit, resultado: columnas[5] ?? '' };
};

const shasCitados = (texto: string): string[] => [
  ...new Set(texto.match(/(?<!\w)[0-9a-f]{8}(?!\w)/gu) ?? [])
];

const vinetaDeDeuda = (): string => {
  const texto = pendientes();
  const inicio = texto.indexOf('- **Deuda de despliegue.**');
  expect(inicio, 'falta la viñeta de deuda de despliegue').toBeGreaterThan(-1);
  const resto = texto.slice(inicio + 1);
  const fin = resto.search(/\n(?=- |## )/u);
  return resto.slice(0, fin === -1 ? undefined : fin);
};

describe('docs/v3.1-pendientes.md: la deuda de despliegue es la real', () => {
  it('cita el último commit que deploy/HISTORIAL.md registra de verdad', () => {
    const { commit } = ultimaFilaDeHistorial();
    expect(
      pendientes(),
      `deploy/HISTORIAL.md ya registra ${commit}: actualizar la deuda de despliegue`
    ).toContain(commit);
  });

  it('no afirma que HISTORIAL registre el despliegue del árbol que el documento describe', () => {
    const { commit } = ultimaFilaDeHistorial();
    const cabeza = git('rev-parse', '--short=8', 'HEAD').trim();
    if (cabeza === commit) return;
    expect(pendientes()).not.toMatch(/`deploy\/HISTORIAL\.md` registra su\s+despliegue/u);
  });

  it('abre una entrada de deuda de despliegue en vez de nombrar un solo commit', () => {
    const texto = pendientes();
    expect(texto).toMatch(/Deuda de despliegue/u);
    expect(texto).not.toMatch(/todavía no registra ese commit/u);
  });

  it('nombra el trabajo de runtime sin desplegar que un lector no adivina', () => {
    const texto = pendientes();
    for (const sha of ['74d9bd08', '095156d1', '511f3fdd', '6cecfb33']) {
      expect(texto, `falta ${sha} en la deuda de despliegue`).toContain(sha);
    }
  });

  it('sólo cita commits reales y ninguno que HISTORIAL ya diera por desplegado', () => {
    const { commit } = ultimaFilaDeHistorial();
    for (const sha of shasCitados(vinetaDeDeuda())) {
      expect(() => git('cat-file', '-e', `${sha}^{commit}`), `${sha} no es un commit`).not.toThrow();
      if (sha === commit) continue;
      const yaDesplegado = (() => {
        try {
          git('merge-base', '--is-ancestor', sha, commit);
          return true;
        } catch {
          return false;
        }
      })();
      expect(yaDesplegado, `${sha} ya está cubierto por la fila de ${commit}`).toBe(false);
    }
  });
});

describe('docs/v3.1-pendientes.md §5: la regla que costó cuatro commits en rojo', () => {
  it('registra que calidad-base.json no se regenera con --update sobre el árbol compartido', () => {
    const texto = pendientes();
    expect(texto).toMatch(/scripts\/calidad-base\.json/u);
    expect(texto).toMatch(/--update/u);
    expect(texto).toContain('7ca643ab');
    expect(texto).toContain('55d76c64');
  });

  it('conserva la prueba dura: la base traía ficheros que ese commit no tenía', () => {
    const huerfanos = [
      'packages/mcp-fleet-monitor/src/tool-server.ts',
      'packages/store/src/repository/agents/chain-control/materialization/lineage.ts',
      'services/gateway/src/terminal/relay-proxy/claim-transition.ts'
    ];
    const base = git('show', '7ca643ab:scripts/calidad-base.json');
    for (const ruta of huerfanos) {
      expect(existeEnCommit('7ca643ab', ruta), `${ruta} sí existía en 7ca643ab`).toBe(false);
      expect(base, `la base de 7ca643ab no traía ${ruta}`).toContain(ruta);
      const nombre = ruta.split('/').at(-1) ?? ruta;
      expect(pendientes(), `§5 no nombra ${nombre}`).toContain(nombre);
    }
  });
});

describe('docs/version-3.1.md: el despliegue que narra y el que quedó registrado', () => {
  it('no da por cumplida la condición del paso 6 mientras la retención siga abierta', () => {
    const texto = version();
    const retencionAbierta = texto.includes('**Retención de grabaciones de TUI.**');
    if (!retencionAbierta) return;
    expect(texto).toContain('9de3f8ec');
    expect(texto).toMatch(/no lo probé/u);
  });

  it('no difumina que la última fila registrada cerró con humo rojo parcial', () => {
    const { commit, resultado } = ultimaFilaDeHistorial();
    if (!resultado.includes('ROJO')) return;
    const texto = version();
    expect(texto).toContain(commit);
    expect(texto).not.toMatch(/con smoke verde y las\s+correcciones\s+posteriores/u);
  });

  it('apunta a la misma fila de HISTORIAL que v3.1-pendientes.md', () => {
    const { commit } = ultimaFilaDeHistorial();
    expect(version(), `la última fila registrada es ${commit} y el documento no la nombra`)
      .toContain(commit);
  });
});
