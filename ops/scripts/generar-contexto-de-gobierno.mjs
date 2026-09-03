#!/usr/bin/env node
/**
 * Emit `ops/schemas/contexto-de-gobierno.json` from the tables of `@cauce/protocol`.
 *
 * The governance-document basenames live in three runtimes that cannot import each other: the
 * protocol (TypeScript), the gateway console catalog, and the pty-agent (Python). This artifact is
 * the byte-for-byte contract between them, so the Python copy is checked against a generated file
 * instead of against a literal someone has to remember to update.
 *
 * `--check` compares without writing and exits 1 on any difference.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destino = path.join(raiz, 'ops/schemas/contexto-de-gobierno.json');

/* Read through the SOURCE: a stale `dist` would make `--check` pass against code nobody runs. */
const { register } = await import('tsx/esm/api');
const desregistrar = register();
let protocolo;
try {
  protocolo = await import(path.join(raiz, 'packages/protocol/src/index.ts'));
} finally {
  await desregistrar();
}

const {
  DOCUMENTOS_DE_GOBIERNO,
  GOVERNANCE_NEVER_SERVE_BASENAMES,
  GOVERNANCE_NEVER_SERVE_SUFFIXES,
  PRESUPUESTOS_DE_CONTEXTO,
} = protocolo;

const aSerpiente = (nombre) => nombre.replace(/[A-Z]/g, (letra) => `_${letra.toLowerCase()}`);

function arnes(entrada, presupuesto) {
  const raizDeclarada = { hecho: aSerpiente(entrada.raiz.hecho) };
  if (entrada.raiz.porDefectoBajoHome !== undefined) {
    raizDeclarada.por_defecto_bajo_home = entrada.raiz.porDefectoBajoHome;
  }
  const presupuestado = { unidad: presupuesto.unit };
  if (presupuesto.porFichero !== undefined) presupuestado.por_fichero = presupuesto.porFichero;
  if (presupuesto.total !== undefined) presupuestado.total = presupuesto.total;
  return {
    raiz: raizDeclarada,
    documentos: [...entrada.documentos],
    presupuesto: presupuestado,
  };
}

const contenido = {
  generado_por: 'ops/scripts/generar-contexto-de-gobierno.mjs',
  fuente: 'packages/protocol/src/ficheros-del-arnes.ts + governance-documents.ts',
  arneses: Object.fromEntries(
    Object.keys(DOCUMENTOS_DE_GOBIERNO).sort().map((nombre) => [
      nombre, arnes(DOCUMENTOS_DE_GOBIERNO[nombre], PRESUPUESTOS_DE_CONTEXTO[nombre]),
    ]),
  ),
  nunca_servir: {
    basenames: [...GOVERNANCE_NEVER_SERVE_BASENAMES],
    sufijos: [...GOVERNANCE_NEVER_SERVE_SUFFIXES],
  },
};

const texto = `${JSON.stringify(contenido, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(destino, 'utf8');
  } catch {
    actual = '';
  }
  if (actual !== texto) {
    process.stderr.write(
      'contexto-de-gobierno.json no corresponde al protocolo; '
      + 'regenerar con `node ops/scripts/generar-contexto-de-gobierno.mjs`\n',
    );
    process.exit(1);
  }
  process.stdout.write('contexto-de-gobierno.json al día\n');
} else {
  writeFileSync(destino, texto);
  process.stdout.write(`escrito ${path.relative(raiz, destino)}\n`);
}
