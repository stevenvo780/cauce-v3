import { createHash } from "node:crypto";
import {
  bloqueGestionado as leerBloqueGestionado, conBloqueGestionado as fusionarBloqueGestionado,
  VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";

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

/*
 * Las marcas y la fusión se MUDARON a `@cauce/protocol/marcas-de-bloque.ts`.
 *
 * Motivo: la consola tiene que enseñar EXACTAMENTE el fichero que va a quedar en el disco —con lo
 * humano intacto alrededor— y el gateway no puede importar este paquete. Lo que queda acá es lo
 * que de verdad necesita el contenedor: el sello (`node:crypto`) y la siembra (el disco).
 *
 * Se re-exportan para que nada de lo que ya las importaba desde aquí tenga que cambiar de sitio.
 */
export {
  bloqueEntreMarcas, bloqueGestionado, conBloqueEntreMarcas, conBloqueGestionado,
  MARCA_FIN, MARCA_INICIO, VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";
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
  const bloque = leerBloqueGestionado(texto);
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

  const actual = leerBloqueGestionado(original);
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
    io.escribir(ruta, fusionarBloqueGestionado(original, textoFijo));
  } catch {
    return "no-se-pudo-escribir";
  }
  return "sembrado";
}
