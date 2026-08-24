import assert from "node:assert/strict";
import test from "node:test";
import {
  MARCA_FIN,
  MARCA_INICIO,
  bloqueGestionado,
  conBloqueGestionado,
  rutaDelContextoFijo,
} from "../src/harnesses/contexto-fijo.js";

/*
 * EL FICHERO DEL ARNÉS NO ES DE CAUCE. Es del alias, y hay personas escribiendo ahí: medido el
 * 2026-08-24, `zeus` tiene 10.733 bytes en su `CLAUDE.md`, `jarvis` 23.762 en su `openclaw.json`
 * y `janus` un `CLAUDE.md` de espacio de trabajo de 510 bytes escrito a mano.
 *
 * El generador que ya existe (`scripts/genera-contexto-harness.sh`) promete en su cabecera que
 * hace copia de seguridad y NO la hace: su `write_file()` es un `cat >` que sobreescribe. Si la
 * siembra automática se comporta así, la primera pasada borra el manual de alguien.
 *
 * De ahí el bloque con marcas: Cauce escribe SÓLO entre ellas y todo lo demás se conserva byte a
 * byte. Estas pruebas son las que impiden que eso se rompa.
 */

const MANUAL_HUMANO = `# El manual de zeus

Esto lo escribió una persona y tiene que sobrevivir a todas las siembras.

## Cosas que no se tocan
- Las credenciales.
`;

test("sobre un fichero con texto humano, el bloque se añade SIN tocar lo demás", () => {
  const resultado = conBloqueGestionado(MANUAL_HUMANO, "CONTRATO GENERADO");
  assert.ok(resultado.startsWith("# El manual de zeus"), "se movió el título de la persona");
  assert.ok(resultado.includes("Esto lo escribió una persona"), "se perdió texto humano");
  assert.ok(resultado.includes("- Las credenciales."), "se perdió texto humano del final");
  assert.equal(bloqueGestionado(resultado), "CONTRATO GENERADO");
});

test("resembrar dos veces no duplica el bloque ni toca lo humano", () => {
  const primera = conBloqueGestionado(MANUAL_HUMANO, "CONTRATO v1");
  const segunda = conBloqueGestionado(primera, "CONTRATO v2");
  assert.equal(bloqueGestionado(segunda), "CONTRATO v2");
  assert.equal(segunda.split(MARCA_INICIO).length - 1, 1, "quedaron dos bloques gestionados");
  assert.ok(segunda.includes("Esto lo escribió una persona"), "la segunda pasada se comió lo humano");
});

test("lo humano de DESPUÉS del bloque también sobrevive a una resiembra", () => {
  const conCola = `${conBloqueGestionado(MANUAL_HUMANO, "v1")}\n## Apéndice de la persona\nOjo con esto.\n`;
  const resembrado = conBloqueGestionado(conCola, "v2");
  assert.ok(resembrado.includes("## Apéndice de la persona"), "se perdió lo que iba después del bloque");
  assert.ok(resembrado.includes("Ojo con esto."));
  assert.equal(bloqueGestionado(resembrado), "v2");
});

test("un fichero vacío recibe el bloque y nada más", () => {
  const resultado = conBloqueGestionado("", "CONTRATO");
  assert.equal(bloqueGestionado(resultado), "CONTRATO");
  assert.ok(resultado.startsWith(MARCA_INICIO));
});

test("una marca de apertura SIN cierre no se lleva por delante el fichero", () => {
  /*
   * Un fichero a medio escribir —una siembra cortada, un disco lleno— tiene la marca de apertura
   * y no la de cierre. Adivinar dónde terminaba el bloque anterior es exactamente cómo se borra
   * texto ajeno. Se conserva TODO y el bloque nuevo va detrás.
   */
  const roto = `${MANUAL_HUMANO}\n${MARCA_INICIO}\nse corto aca`;
  const resultado = conBloqueGestionado(roto, "CONTRATO NUEVO");
  assert.ok(resultado.includes("Esto lo escribió una persona"));
  assert.ok(resultado.includes("se corto aca"), "se descartó el bloque a medio escribir sin mirarlo");
  assert.equal(bloqueGestionado(resultado), "CONTRATO NUEVO");
});

// ── CONTROLES NEGATIVOS ─────────────────────────────────────────────────────────────────────

test("CONTROL NEGATIVO: sin marcas no hay bloque, y no se inventa uno", () => {
  assert.equal(bloqueGestionado(MANUAL_HUMANO), undefined);
  assert.equal(bloqueGestionado(""), undefined);
});

test("CONTROL NEGATIVO: con la marca de apertura pero sin cierre, NO hay bloque", () => {
  assert.equal(bloqueGestionado(`${MARCA_INICIO}\ncontenido a medias`), undefined);
});

test("CONTROL NEGATIVO: openclaw NO tiene ruta de fichero de texto", () => {
  /*
   * `openclaw.json` guarda `auth` y `secrets` junto a la directiva, y está en la lista de «nunca
   * se sirve» del pty-agent y del gateway. Devolver una ruta aquí llevaría a escribirlo entero.
   */
  assert.equal(rutaDelContextoFijo("openclaw", "/home/claw"), undefined);
  assert.equal(rutaDelContextoFijo("hermes", "/home/dev"), undefined);
});

test("la ruta respeta CLAUDE_CONFIG_DIR y CODEX_HOME, que es como se separan los alias", () => {
  assert.equal(rutaDelContextoFijo("claude", "/home/dev", {}), "/home/dev/.claude/CLAUDE.md");
  assert.equal(rutaDelContextoFijo("codex", "/home/dev", {}), "/home/dev/.codex/AGENTS.md");
  assert.equal(
    rutaDelContextoFijo("claude", "/home/dev", { CLAUDE_CONFIG_DIR: "/home/dev/.cauce/atlas/.claude" }),
    "/home/dev/.cauce/atlas/.claude/CLAUDE.md",
  );
  // Una ruta relativa se ignora en vez de componerse: componerla daría un fichero fuera del home.
  assert.equal(rutaDelContextoFijo("codex", "/home/dev", { CODEX_HOME: "relativa" }), "/home/dev/.codex/AGENTS.md");
});

test("el cierre del bloque queda bien formado y es reconocible", () => {
  const resultado = conBloqueGestionado(MANUAL_HUMANO, "X");
  assert.ok(resultado.includes(MARCA_FIN));
  assert.equal(resultado.split(MARCA_FIN).length - 1, 1);
});
