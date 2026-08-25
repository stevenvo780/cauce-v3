import { createHash } from "node:crypto";

/**
 * EL SELLO DEL CONTEXTO FIJO.
 *
 * ── El problema, medido el 2026-08-24 ────────────────────────────────────────────────────────
 *
 * Cada entrega arrastra el mismo texto fijo: identidad, DEBER PRIMARIO, contrato de salida, las
 * invariantes de protocolo y las mecánicas de delegación. Llamando a `protocolPrompt()` de verdad:
 * 7.694 caracteres en esta rama y 9.210 en el build desplegado, contra 62 de pedido real. 161 a 1.
 *
 * Ese texto NO cambia entre un turno y el siguiente. Cambia cuando cambia el código o el perfil
 * del alias, y nada más. Su sitio es el fichero del arnés —`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, el campo `agents` de `openclaw.json`—, que el modelo ya carga solo.
 *
 * ── Por qué hace falta un SELLO y no basta con «lo movimos» ──────────────────────────────────
 *
 * Si el adaptador deja de mandar lo fijo dando por sentado que el fichero está sembrado, el día
 * que el fichero no esté —contenedor recreado, alias nuevo, siembra a medias, arnés sin fichero
 * como hermes— el agente se queda SIN CONTRATO y no lo dice nadie: contesta mal y parece que el
 * modelo se volvió tonto. Es exactamente la clase de fallo que esta flota ya conoce: no da error,
 * da un comportamiento raro que cuesta días adjudicar.
 *
 * El sello convierte esa suposición en una comprobación. El que mide el fichero DENTRO del
 * contenedor calcula el resumen del bloque gestionado y lo manda en el sobre. El adaptador
 * calcula el resumen del texto que ÉL habría emitido. Si coinciden, el fichero ya lo dice y no se
 * repite. Si no coinciden —o no hay sello— se emite todo, como hoy.
 *
 * **Falla del lado seguro por construcción**: la ausencia de información produce el comportamiento
 * de siempre, nunca el recorte. Un sello no se puede fabricar por accidente: es el resumen del
 * texto exacto.
 */

/** Versión del contrato del bloque gestionado. Cambiarla invalida todos los sellos a la vez. */
export const VERSION_CONTEXTO_FIJO = "1";

/**
 * Las marcas del bloque gestionado dentro del fichero del arnés.
 *
 * El fichero NO es de Cauce: es del alias, y una persona escribe ahí. Todo lo que Cauce genera
 * vive entre estas dos marcas y **lo de fuera se conserva byte a byte**. Sin eso, la primera
 * siembra pisaría el manual que alguien escribió a mano — que es exactamente lo que hace hoy
 * `scripts/genera-contexto-harness.sh`, que promete una copia de seguridad en su cabecera y no
 * hace ninguna.
 *
 * Van en comentario HTML porque en Markdown no se ven al leer, y `openclaw.json` no usa este
 * camino (ahí el bloque es un campo del JSON, ver `rutaDelContextoFijo`).
 */
export const MARCA_INICIO = `<!-- CAUCE:CONTEXTO-FIJO v${VERSION_CONTEXTO_FIJO} — generado, no editar dentro de este bloque -->`;
export const MARCA_FIN = "<!-- CAUCE:FIN-CONTEXTO-FIJO -->";

export interface SelloDeContextoFijo {
  /** `VERSION_CONTEXTO_FIJO` con el que se escribió el fichero. */
  readonly version: string;
  /** sha256 en hexadecimal del texto fijo, tal cual quedó escrito en el fichero del arnés. */
  readonly sha256: string;
}

/**
 * El resumen del texto fijo. Es sha256 y no un contador de longitud a propósito: dos textos
 * distintos del mismo largo son un caso real —una regla cambiada palabra por palabra— y darían
 * por bueno un fichero que dice otra cosa.
 */
export function resumirContextoFijo(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/**
 * ¿El fichero del arnés ya lleva EXACTAMENTE este texto fijo?
 *
 * Las tres respuestas negativas son deliberadamente indistinguibles para quien llama: sin sello,
 * con versión vieja o con resumen distinto, la respuesta es la misma —«mandalo entero»—. Quien
 * quiera saber POR QUÉ tiene `motivoDeReenvio()`, que es para el diagnóstico y no para decidir.
 */
export function elFicheroYaLoDice(
  sello: SelloDeContextoFijo | undefined,
  textoFijo: string,
): boolean {
  if (!sello) return false;
  if (sello.version !== VERSION_CONTEXTO_FIJO) return false;
  return sello.sha256 === resumirContextoFijo(textoFijo);
}

export type MotivoDeReenvio =
  | "sin-sello"
  | "version-distinta"
  | "contenido-distinto"
  | "no-hace-falta";

/**
 * Por qué se reenvió el texto fijo. Va al registro del adaptador, NO a la decisión: separar el
 * diagnóstico de la decisión es lo que evita que alguien, mañana, trate «version-distinta» como
 * un caso tolerable y recorte igual.
 */
export function motivoDeReenvio(
  sello: SelloDeContextoFijo | undefined,
  textoFijo: string,
): MotivoDeReenvio {
  if (!sello) return "sin-sello";
  if (sello.version !== VERSION_CONTEXTO_FIJO) return "version-distinta";
  if (sello.sha256 !== resumirContextoFijo(textoFijo)) return "contenido-distinto";
  return "no-hace-falta";
}

/**
 * El renglón que sustituye al bloque fijo cuando el fichero ya lo dice.
 *
 * No se queda en silencio, y esto es una decisión. Un modelo que abre un turno sin ninguna
 * referencia a su contrato puede razonablemente concluir que no lo tiene; una línea que le dice
 * dónde está cuesta 120 caracteres contra 7.694 y quita esa duda. Además deja una marca
 * buscable en los transcripts para poder auditar, después, si el recorte estuvo activo.
 */
export function renglonDeContextoFijo(): string {
  return (
    "Tu contrato de identidad, deber y protocolo NO se repite en esta entrega: ya está cargado " +
    `desde el fichero de instrucciones de tu arnés (contexto Cauce v${VERSION_CONTEXTO_FIJO}). ` +
    "Rige igual. Si no lo tenés delante, decilo en tu \"reply\" y seguí con lo que puedas."
  );
}

// ── Leer el sello del disco, desde DENTRO del contenedor ────────────────────────────────────

/**
 * Dónde vive el fichero de instrucciones de cada arnés.
 *
 * Las rutas salen de lo MEDIDO en producción el 2026-08-24, contenedor por contenedor, no del
 * registro de la base —que estaba equivocado en 5 de los 14 alias—:
 *   claude   → `<CLAUDE_CONFIG_DIR|~/.claude>/CLAUDE.md`
 *   codex    → `<CODEX_HOME|~/.codex>/AGENTS.md`
 *   openclaw → `<home>/.openclaw/openclaw.json`, y ahí NO es el fichero: es el campo `agents`.
 *
 * `openclaw.json` devuelve `undefined` a propósito: ese fichero guarda `auth` y `secrets` junto a
 * la directiva, está en la lista de «nunca se sirve» del pty-agent y del gateway, y tratarlo como
 * un fichero de texto llevaría a escribirlo entero. Su siembra necesita proyección campo a campo,
 * que es otro camino.
 */
export function rutaDelContextoFijo(
  harness: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const absoluta = (valor: string | undefined): string | undefined =>
    valor && valor.startsWith("/") ? valor : undefined;
  if (harness === "claude") {
    return `${absoluta(environment.CLAUDE_CONFIG_DIR) ?? `${home}/.claude`}/CLAUDE.md`;
  }
  if (harness === "codex") {
    return `${absoluta(environment.CODEX_HOME) ?? `${home}/.codex`}/AGENTS.md`;
  }
  return undefined;
}

/**
 * El bloque gestionado dentro del texto de un fichero, o `undefined` si no está.
 *
 * Devuelve el contenido SIN las marcas: lo que se resume es el texto, no su envoltorio, para que
 * cambiar la redacción de una marca no invalide todos los sellos de la flota a la vez.
 */
export function bloqueGestionado(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_INICIO, MARCA_FIN);
}

/** El contenido entre CUALQUIER par de marcas, sin las marcas. Ver `conBloqueEntreMarcas`. */
export function bloqueEntreMarcas(
  texto: string, marcaInicio: string, marcaFin: string,
): string | undefined {
  const par = parDeMarcas(texto, marcaInicio, marcaFin);
  if (!par) return undefined;
  return texto.slice(par.desde, par.fin).trim();
}

/**
 * El par de marcas que delimita el bloque VIGENTE, o `undefined` si no hay ninguno cerrado.
 *
 * Busca la ÚLTIMA apertura que tenga cierre detrás, no la primera. La diferencia la destapó una
 * prueba: si una siembra se cortó a medias queda una apertura huérfana, y leer desde la primera
 * devolvía el texto roto MÁS la apertura siguiente MÁS el bloque nuevo — un «bloque» que no es
 * ninguno de los dos y cuyo resumen no coincidiría nunca con nada. Con la última, el fichero a
 * medio escribir queda como texto inerte y el bloque vigente se lee limpio.
 */
function parDeMarcas(
  texto: string, marcaInicio: string, marcaFin: string,
): { inicio: number; desde: number; fin: number } | undefined {
  let inicio = -1;
  for (let busca = texto.indexOf(marcaInicio); busca !== -1; busca = texto.indexOf(marcaInicio, busca + 1)) {
    if (texto.indexOf(marcaFin, busca + marcaInicio.length) !== -1) inicio = busca;
  }
  if (inicio === -1) return undefined;
  const desde = inicio + marcaInicio.length;
  const fin = texto.indexOf(marcaFin, desde);
  if (fin === -1) return undefined;
  return { inicio, desde, fin };
}

/**
 * Escribe el bloque gestionado dentro de un fichero, conservando lo de fuera BYTE A BYTE.
 *
 * Si no había bloque, lo añade al final separado por una línea en blanco: nunca al principio,
 * porque lo primero de un `CLAUDE.md` suele ser el título que escribió una persona.
 */
export function conBloqueGestionado(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_INICIO, MARCA_FIN);
}

/**
 * La misma fusión, para CUALQUIER par de marcas.
 *
 * Existe porque el fichero del arnés lleva DOS bloques y no uno: el contrato sellado (estas
 * marcas) y el perfil del alias (las suyas, en `context/perfil-a-contexto.ts`). Están separados
 * porque el sello resume el contrato —que incluye `Tu rol:` con el `role_brief` de siempre, tope
 * 1.200 puntos de código— y el perfil rico admite 24.000: meter el perfil dentro del bloque
 * sellado haría que el sha del fichero no coincidiera NUNCA con el que calcula el adaptador, y el
 * recorte del sobre no se activaría jamás sin que apareciera un solo error.
 *
 * Se generaliza en vez de copiarse porque la parte sutil —buscar la ÚLTIMA apertura que tenga
 * cierre detrás, no la primera— ya costó una prueba descubrirla. Dos copias de esa lógica son dos
 * sitios donde volver a equivocarse; el segundo se arregla tarde y en silencio.
 */
export function conBloqueEntreMarcas(
  textoOriginal: string, bloque: string, marcaInicio: string, marcaFin: string,
): string {
  const nuevo = `${marcaInicio}\n${bloque.trim()}\n${marcaFin}`;
  const par = parDeMarcas(textoOriginal, marcaInicio, marcaFin);
  if (!par) {
    /*
     * No hay bloque cerrado. Puede que no haya nada, o que haya una apertura huérfana de una
     * siembra cortada. En los dos casos se conserva TODO lo anterior y el bloque nuevo va detrás:
     * adivinar dónde terminaba un bloque a medio escribir es exactamente cómo se borra texto
     * ajeno, y ese texto puede ser el manual que escribió una persona.
     */
    const base = textoOriginal.trimEnd();
    return base.length === 0 ? `${nuevo}\n` : `${base}\n\n${nuevo}\n`;
  }
  return textoOriginal.slice(0, par.inicio) + nuevo + textoOriginal.slice(par.fin + marcaFin.length);
}

/**
 * El sello del fichero que hay AHORA en el disco, leído desde dentro del contenedor.
 *
 * ── Por qué lo lee el adaptador y no el gateway ──────────────────────────────────────────────
 *
 * El adaptador YA corre dentro del contenedor del alias, con su usuario y con su `$HOME`. Puede
 * abrir el fichero directamente. Hacer que el gateway lo mida exigiría la cadena
 * gateway → relay → pty-agent, que el 2026-08-24 no existe en producción (los tres eslabones dan
 * 404 o no tienen la capacidad) y que además obliga a un viaje de red por cada entrega.
 *
 * Esta es la simplificación que pedía el encargo: el que necesita el dato es el que ya lo tiene
 * delante.
 *
 * ── Nunca lanza ─────────────────────────────────────────────────────────────────────────────
 *
 * Fichero ausente, sin permisos, disco lleno, ruta que resultó ser un directorio: todo devuelve
 * `undefined`, y `undefined` significa «mandá el sobre entero», que es el comportamiento de
 * siempre. Un fallo de lectura NO puede costar un turno.
 */
export function selloDesdeElDisco(
  ruta: string | undefined,
  leer: (ruta: string) => string,
): SelloDeContextoFijo | undefined {
  if (!ruta) return undefined;
  let texto: string;
  try {
    texto = leer(ruta);
  } catch {
    return undefined;
  }
  const bloque = bloqueGestionado(texto);
  if (bloque === undefined) return undefined;
  return { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(bloque) };
}

/** Por qué NO se sembró el fichero. Va al registro; el turno sigue igual. */
export type MotivoDeNoSembrar =
  | "sembrado"
  | "apagado"
  | "sin-ruta"
  | "ya-estaba"
  | "ocupado-por-otro-alias"
  | "no-se-pudo-escribir";

/**
 * Escribe el bloque gestionado en el fichero del arnés, si hace falta y si se puede.
 *
 * ── Por qué lo siembra el propio adaptador ──────────────────────────────────────────────────
 *
 * Es el mismo argumento que para leerlo: el adaptador ya corre dentro del contenedor, con el
 * usuario del alias. Sembrar desde fuera exigiría un canal de escritura hasta el disco de cada
 * contenedor —que hoy no existe— y un despliegue coordinado. Así, el primer turno tras una
 * actualización escribe el bloque y manda el sobre entero; del segundo en adelante el sobre va
 * recortado. Se cura solo, sin ventana de mantenimiento.
 *
 * ── La negativa que importa: FICHERO COMPARTIDO ─────────────────────────────────────────────
 *
 * `kratos` y `atlas` comparten `$HOME` y su `AGENTS.md` es el MISMO inodo (medido: 12.942 bytes
 * en los dos el 24-ago-2026). Si los dos sembraran, cada uno pisaría al otro en cada turno: el
 * fichero oscilaría entre dos identidades y ninguno de los dos tendría nunca su contrato. Por eso
 * cuando el bloque existe y NO es el nuestro, no se toca y se devuelve
 * `ocupado-por-otro-alias`. La cura de eso no es escribir más fuerte: es darle a cada alias su
 * propio directorio de configuración.
 *
 * Nunca lanza. Un fallo al sembrar deja el sobre entero, que es el comportamiento de siempre.
 */
export function sembrarContextoFijo(
  ruta: string | undefined,
  textoFijo: string,
  io: {
    leer: (ruta: string) => string;
    escribir: (ruta: string, contenido: string) => void;
    habilitado: boolean;
  },
): MotivoDeNoSembrar {
  if (!io.habilitado) return "apagado";
  if (!ruta) return "sin-ruta";

  let original: string;
  try {
    original = io.leer(ruta);
  } catch {
    // Que no exista es normal la primera vez: se siembra sobre un fichero vacío.
    original = "";
  }

  const actual = bloqueGestionado(original);
  if (actual === textoFijo) return "ya-estaba";
  if (actual !== undefined && actual !== textoFijo) {
    /*
     * Hay un bloque y dice otra cosa. Son dos casos y desde aquí no se distinguen: o el contrato
     * cambió (y hay que reescribirlo), o el fichero es de otro alias que comparte `$HOME` (y
     * reescribirlo sería empezar una guerra de escrituras). Ante la duda no se pisa, porque el
     * daño de las dos opciones no es simétrico: reescribir de más deja a dos alias sin identidad
     * estable; reescribir de menos sólo cuesta un sobre entero por turno, que es lo de hoy.
     */
    return "ocupado-por-otro-alias";
  }

  try {
    io.escribir(ruta, conBloqueGestionado(original, textoFijo));
  } catch {
    return "no-se-pudo-escribir";
  }
  return "sembrado";
}
