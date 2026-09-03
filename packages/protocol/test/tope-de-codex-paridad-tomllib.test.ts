import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { MAX_CODEX_PROJECT_DOC_BYTES } from "../src/governance-documents.js";
import { topeDeCodexEnConfigToml } from "../src/ficheros-del-arnes.js";

/*
 * The measured fact is produced by the pty-agent with Python `tomllib`; the seeding inside the
 * container cannot wait for the pty-agent, so it keeps its own reader of `config.toml`. The two
 * are allowed to disagree in ONE direction only: the scanner may refuse a cap tomllib reads
 * (smaller budget, nothing is written), never the other way round — a file Codex will truncate
 * must never be written. This corpus is the tripwire that makes any drift visible.
 */

const LECTOR_DE_TOMLLIB = `
import sys, tomllib
try:
    analizado = tomllib.loads(sys.stdin.read())
except Exception:
    print("nada")
    raise SystemExit(0)
valor = analizado.get("project_doc_max_bytes")
if isinstance(valor, bool) or not isinstance(valor, int) \\
        or valor < 1 or valor > ${String(MAX_CODEX_PROJECT_DOC_BYTES)}:
    print("nada")
else:
    print(valor)
`;

const HAY_TOMLLIB = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

function conTomllib(texto: string): number | undefined {
  const salida = spawnSync("python3", ["-c", LECTOR_DE_TOMLLIB], { input: texto, encoding: "utf8" });
  if (salida.status !== 0) {
    throw new Error(`python3 no pudo leer la muestra: ${salida.stderr}`);
  }
  const crudo = salida.stdout.trim();
  return crudo === "nada" ? undefined : Number(crudo);
}

interface Muestra {
  readonly nombre: string;
  readonly toml: string;
  /** tomllib reads a cap the scanner refuses. Allowed, and listed one by one on purpose. */
  readonly cerradoConocido?: true;
}

const CORPUS: readonly Muestra[] = [
  { nombre: "decimal", toml: "project_doc_max_bytes = 65536\n" },
  { nombre: "decimal con guiones bajos", toml: "project_doc_max_bytes = 65_536\n" },
  { nombre: "signo + delante", toml: "project_doc_max_bytes = +65536\n" },
  { nombre: "hexadecimal", toml: "project_doc_max_bytes = 0x10000\n" },
  { nombre: "hexadecimal con guion bajo", toml: "project_doc_max_bytes = 0x1_0000\n" },
  { nombre: "octal", toml: "project_doc_max_bytes = 0o200000\n" },
  { nombre: "binario", toml: "project_doc_max_bytes = 0b1000000000000000\n" },
  { nombre: "clave entrecomillada", toml: "\"project_doc_max_bytes\" = 65536\n" },
  { nombre: "clave con comillas literales", toml: "'project_doc_max_bytes' = 65536\n" },
  { nombre: "comentario al final", toml: "project_doc_max_bytes = 65536 # medido\n" },
  {
    nombre: "CRLF y otra clave antes",
    toml: "model = \"gpt\"\r\nproject_doc_max_bytes = 65536\r\n",
  },
  {
    nombre: "escalares que el escáner tiene que saber clasificar",
    toml: "aprobado = true\ntemperatura = 0.7\ncreado = 2026-01-01T10:00:00Z\n"
      + "abierto = 09:30:00\nproject_doc_max_bytes = 65536\n",
  },
  {
    nombre: "cadena con almohadilla dentro",
    toml: "titulo = \"con # dentro\"\nproject_doc_max_bytes = 65536\n",
  },
  {
    nombre: "valor sin comillas",
    toml: "model = sin comillas\nproject_doc_max_bytes = 65536\n",
  },
  {
    nombre: "la clave dentro de una cadena multilínea",
    toml: "notes = \"\"\"\nproject_doc_max_bytes = 65536\n\"\"\"\n",
  },
  {
    nombre: "la clave tras una cabecera de tabla",
    toml: "[profiles.zeus]\nproject_doc_max_bytes = 999999\n",
  },
  {
    nombre: "la clave dentro de una tabla en línea",
    toml: "tabla = { project_doc_max_bytes = 65536 }\n",
  },
  { nombre: "clave duplicada", toml: "project_doc_max_bytes = 1\nproject_doc_max_bytes = 2\n" },
  {
    nombre: "otra clave de la raíz duplicada",
    toml: "model = \"a\"\nmodel = \"b\"\nproject_doc_max_bytes = 65536\n",
  },
  {
    nombre: "comilla sin cerrar",
    toml: "model = \"abierta\nproject_doc_max_bytes = 65536\n",
  },
  {
    nombre: "ceros a la izquierda en otra clave",
    toml: "reintentos = 01\nproject_doc_max_bytes = 65536\n",
  },
  { nombre: "valor fuera de rango", toml: "project_doc_max_bytes = 16777217\n" },
  { nombre: "valor flotante", toml: "project_doc_max_bytes = 65536.0\n" },
  { nombre: "valor negativo", toml: "project_doc_max_bytes = -1\n" },
  { nombre: "sólo comentarios", toml: "# un config comentado\n# y nada más\n" },
  { nombre: "fichero vacío", toml: "" },
  {
    nombre: "cabecera de tabla mal formada",
    toml: "project_doc_max_bytes = 65536\n[sin cerrar\n",
  },
  {
    nombre: "una tabla pisa una clave de la raíz",
    toml: "tabla = 1\nproject_doc_max_bytes = 65536\n[tabla]\nclave = 2\n",
  },
  {
    nombre: "clave con punto",
    toml: "perfil.modelo = \"gpt\"\nproject_doc_max_bytes = 65536\n",
    cerradoConocido: true,
  },
  {
    nombre: "array en la raíz",
    toml: "project_doc_fallback_filenames = [\"AGENTS.override.md\"]\n"
      + "project_doc_max_bytes = 65536\n",
    cerradoConocido: true,
  },
  { nombre: "BOM al principio", toml: "\uFEFFproject_doc_max_bytes = 65536\n" },
  { nombre: "NBSP delante de la clave", toml: "\u00A0project_doc_max_bytes = 65536\n" },
  { nombre: "espacio fino delante de la clave", toml: "\u2009project_doc_max_bytes = 65536\n" },
  { nombre: "salto de página delante de la clave", toml: "\fproject_doc_max_bytes = 65536\n" },
  { nombre: "tabulación vertical delante de la clave", toml: "\vproject_doc_max_bytes = 65536\n" },
  { nombre: "NBSP al final de la línea", toml: "project_doc_max_bytes = 65536\u00A0\n" },
  { nombre: "BOM a mitad del fichero", toml: "model = \"a\"\n\uFEFFproject_doc_max_bytes = 65536\n" },
  { nombre: "escape que no es escalar Unicode", toml: "x = \"\\uD800\"\nproject_doc_max_bytes = 65536\n" },
  { nombre: "escape largo fuera de rango", toml: "x = \"\\U00110000\"\nproject_doc_max_bytes = 65536\n" },
  { nombre: "hora sin segundos", toml: "t = 10:30\nproject_doc_max_bytes = 65536\n" },
  { nombre: "carácter de control en un comentario", toml: "project_doc_max_bytes = 65536\n# \u0007 malo\n" },
  { nombre: "array de tablas tras la clave", toml: "project_doc_max_bytes = 65536\n[[a]]\nx = 1\n" },
  {
    nombre: "NBSP dentro de una cadena básica",
    toml: "titulo = \"a\u00A0b\"\nproject_doc_max_bytes = 65536\n",
    cerradoConocido: true,
  },
];

test("el escáner de config.toml nunca diverge de tomllib en dirección ABIERTA", (ctx) => {
  if (!HAY_TOMLLIB) {
    ctx.skip("el python3 de esta máquina no trae tomllib: la paridad no se pudo medir");
    return;
  }
  for (const muestra of CORPUS) {
    const escaner = topeDeCodexEnConfigToml(muestra.toml);
    const referencia = conTomllib(muestra.toml);
    assert.ok(
      escaner === undefined || referencia !== undefined,
      `divergencia ABIERTA en «${muestra.nombre}»: el escáner lee ${String(escaner)} y tomllib nada`,
    );
    if (muestra.cerradoConocido === true) {
      assert.equal(escaner, undefined, `«${muestra.nombre}» ya no es un cierre conocido`);
      assert.notEqual(referencia, undefined, `«${muestra.nombre}» ya no lo lee tomllib`);
      continue;
    }
    assert.equal(escaner, referencia, `«${muestra.nombre}» no lee lo mismo que tomllib`);
  }
});
