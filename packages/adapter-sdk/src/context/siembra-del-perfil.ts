import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ErrorDeTopeDelArnes, ficherosDelArnes, nombresDelArnes, type ContextoDeAlias,
  type FicheroGenerado,
} from "@cauce/protocol";

/**
 * EL QUE DE VERDAD TOCA EL DISCO: escribe el perfil del alias en los ficheros que su arnés lee.
 *
 * ============================================================================================
 * POR QUÉ ESTO CIERRA EL LAZO
 * ============================================================================================
 * `ficherosDelArnes()` componía el texto correcto y NO TENÍA UN SOLO LLAMADOR en producción: era
 * una isla exportada. El operador editaba el perfil en la consola, veía la vista previa, le daba a
 * guardar, la base lo guardaba... y ningún byte llegaba nunca a ningún contenedor.
 *
 * Esto es la última pieza. Lo llama el adaptador al conectar, con el perfil que le llega en el
 * `hello_ack`, y a partir de ahí el fichero del arnés dice lo que dice la base.
 *
 * ============================================================================================
 * POR QUÉ ESCRIBE EL ADAPTADOR Y NO EL GATEWAY
 * ============================================================================================
 * Mismo argumento que para el sello del bloque A: el adaptador YA corre dentro del contenedor del
 * alias, con su usuario y su `$HOME`. Puede abrir el fichero. Que lo escribiera el gateway
 * exigiría la cadena gateway → relay → pty-agent, que el 2026-08-24 no existe en producción —los
 * tres eslabones dan 404 o no tienen la capacidad— y un canal de escritura hasta el disco de cada
 * contenedor, que es superficie nueva y peligrosa.
 *
 * ============================================================================================
 * UNA VEZ POR CONEXIÓN, NO POR ENTREGA
 * ============================================================================================
 * Se llama desde el saludo. Un alias que se reconecta reescribe si hace falta, y si no hace falta
 * `ficherosDelArnes` devuelve `escribir: false` y no se abre el fichero para nada. Escribirlo por
 * entrega sería reintroducir por otra vía el coste que este trabajo vino a quitar.
 *
 * ============================================================================================
 * NUNCA LANZA
 * ============================================================================================
 * Un fallo escribiendo deja el fichero como estaba, que es el comportamiento de siempre. Lo que NO
 * puede pasar es que un alias se quede sin conectar porque no se pudo componer un fichero: eso
 * cambiaría un problema de presentación por un agente sordo. Devuelve el parte de lo ocurrido para
 * que quien llame lo registre.
 */

/** Qué pasó con cada fichero. Va al registro; el turno sigue igual pase lo que pase. */
export type ResultadoDeFichero =
  | { readonly nombre: string; readonly estado: "escrito" }
  | { readonly nombre: string; readonly estado: "ya-estaba" }
  /** El bloque que hay es de OTRO alias: `kratos` y `atlas` comparten `$HOME`. No se pisa. */
  | { readonly nombre: string; readonly estado: "ocupado-por-otro-alias" }
  | { readonly nombre: string; readonly estado: "no-se-pudo-escribir"; readonly motivo: string };

export type ResultadoDeLaSiembra =
  | { readonly estado: "apagado" }
  /** El arnés no es de los que Cauce sabe escribir, o no se sabe cuál es. */
  | { readonly estado: "sin-ficheros"; readonly harness: string }
  /** Un fichero —o la suma— se pasa del tope del arnés. NO se escribe ninguno. */
  | { readonly estado: "no-entra"; readonly fichero: string; readonly medido: number; readonly tope: number }
  | { readonly estado: "hecho"; readonly ficheros: readonly ResultadoDeFichero[] };

/** El disco, inyectable para poder probar la siembra sin tocar el sistema de ficheros. */
export interface DiscoDelArnes {
  /** `undefined` si el fichero no está. Cualquier otro fallo se propaga. */
  leer(ruta: string): string | undefined;
  escribir(ruta: string, contenido: string): void;
}

export const discoReal: DiscoDelArnes = {
  leer(ruta) {
    try {
      return readFileSync(ruta, "utf8");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  escribir(ruta, contenido) {
    /*
     * El directorio puede no existir: `argos` no tenía NINGUNO de los siete ficheros el 24-ago, y
     * su espacio de trabajo puede estar vacío. Crear el directorio es parte de sembrar.
     *
     * Escritura DIRECTA y no atómica (temporal + rename) a propósito. Un `rename` sobre un
     * bind-mount cambia el INODO, y en esta flota eso ya tumbó el puente tres minutos: el
     * contenedor sigue apuntando al inodo viejo y deja de ver lo que se escribe. Aquí además da
     * igual: el peor caso de una escritura cortada es un bloque a medias, que `parDeMarcas` ya
     * trata como texto inerte y la siguiente siembra repara.
     */
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, contenido, "utf8");
  },
};

/**
 * Dónde vive el espacio de trabajo cuyos ficheros lee el arnés.
 *
 * MEDIDO contenedor por contenedor el 2026-08-24, no deducido:
 *   claude   → `$CLAUDE_CONFIG_DIR` si está, si no `$HOME/.claude`
 *   codex    → `$CODEX_HOME` si está, si no `$HOME/.codex`
 *   openclaw → el espacio de trabajo del agente, la familia de siete Markdown
 *
 * `CLAUDE_CONFIG_DIR` GANA sobre `$HOME` y no es un detalle: es el mecanismo con el que dos alias
 * del mismo contenedor tienen ficheros distintos. Una prueba mía se puso roja por leer mi
 * `CLAUDE.md` de verdad justamente por no respetarlo.
 */
export function directorioDelArnes(
  harness: string, entorno: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = entorno.HOME;
  if (harness === "claude") {
    return entorno.CLAUDE_CONFIG_DIR ?? (home === undefined ? undefined : join(home, ".claude"));
  }
  if (harness === "codex") {
    return entorno.CODEX_HOME ?? (home === undefined ? undefined : join(home, ".codex"));
  }
  if (harness === "openclaw") {
    /*
     * `CAUCE_OPENCLAW_WORKSPACE` primero porque el espacio de trabajo de un agente openclaw NO es
     * su `$HOME`: es el directorio donde el arnés carga su familia de siete. Sin la variable no se
     * adivina —`$HOME` sería casi siempre el sitio equivocado, y sembrar siete Markdown en el
     * sitio equivocado es peor que no sembrar—, así que se devuelve `undefined` y no se toca nada.
     */
    return entorno.CAUCE_OPENCLAW_WORKSPACE;
  }
  return undefined;
}

export interface OpcionesDeSiembra {
  /** Sin esto no se escribe NADA. Se enciende con `CAUCE_SEMBRAR_PERFIL=1`. */
  readonly habilitado: boolean;
  readonly disco?: DiscoDelArnes;
  readonly entorno?: NodeJS.ProcessEnv;
}

/**
 * Escribe el perfil en los ficheros del arnés. Nunca lanza.
 *
 * El interruptor está APAGADO por defecto y es deliberado: esto escribe dentro del contenedor de
 * quince agentes que están trabajando. Encenderlo es una decisión con fecha y con alguien mirando,
 * no un efecto secundario de desplegar una versión.
 */
export function sembrarPerfilDelArnes(
  harness: string,
  contexto: ContextoDeAlias,
  opciones: OpcionesDeSiembra,
): ResultadoDeLaSiembra {
  if (!opciones.habilitado) return { estado: "apagado" };

  const nombres = nombresDelArnes(harness);
  if (nombres.length === 0) return { estado: "sin-ficheros", harness };

  const directorio = directorioDelArnes(harness, opciones.entorno ?? process.env);
  if (directorio === undefined) return { estado: "sin-ficheros", harness };

  const disco = opciones.disco ?? discoReal;

  // Lo que hay AHORA en el disco. Un fallo leyendo se trata como «no está»: el generador conserva
  // byte a byte lo que reciba, así que darle menos de lo que hay sólo puede acabar en un fichero
  // reescrito, nunca en uno mutilado — la fusión no borra lo que no ve porque no lo busca.
  const existentes = new Map<string, string>();
  for (const nombre of nombres) {
    try {
      const contenido = disco.leer(join(directorio, nombre));
      if (contenido !== undefined) existentes.set(nombre, contenido);
    } catch {
      // Se sigue: un fichero ilegible no puede impedir sembrar los otros seis.
    }
  }

  let generados: readonly FicheroGenerado[];
  try {
    generados = ficherosDelArnes(harness, contexto, existentes);
  } catch (error) {
    if (error instanceof ErrorDeTopeDelArnes) {
      // No se escribe NINGUNO. Una persona a medias —cuatro ficheros al día y tres no— se
      // contradice a sí misma, y el modelo no tiene forma de saber cuál creer.
      return { estado: "no-entra", fichero: error.fichero, medido: error.medido, tope: error.tope };
    }
    return { estado: "no-entra", fichero: "desconocido", medido: 0, tope: 0 };
  }

  const ficheros: ResultadoDeFichero[] = [];
  for (const fichero of generados) {
    if (!fichero.escribir) {
      /*
       * `escribir: false` sobre un fichero que YA existe y cuyo texto NO es el nuestro sólo puede
       * ser la guarda de dueño: `ficherosDelArnes` devuelve el previo intacto cuando el bloque es
       * de otro alias. Distinguirlo importa porque «ya estaba al día» y «no lo toco porque es de
       * otro» son dos cosas muy distintas para quien lee el registro buscando por qué un alias no
       * tiene su perfil.
       */
      const previo = existentes.get(fichero.nombre);
      const ajeno = previo !== undefined && previo === fichero.texto
        && fichero.politica === "bloque-gestionado" && previo.includes("CAUCE:PERFIL")
        && !previo.includes(`<!-- alias: ${contexto.perfil.tenant_id}/${contexto.perfil.alias} -->`);
      ficheros.push({ nombre: fichero.nombre, estado: ajeno ? "ocupado-por-otro-alias" : "ya-estaba" });
      continue;
    }
    try {
      disco.escribir(join(directorio, fichero.nombre), fichero.texto);
      ficheros.push({ nombre: fichero.nombre, estado: "escrito" });
    } catch (error) {
      ficheros.push({
        nombre: fichero.nombre,
        estado: "no-se-pudo-escribir",
        motivo: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { estado: "hecho", ficheros };
}

/** Un renglón para el registro, legible por una persona. Nunca lleva el contenido del fichero. */
export function resumenDeLaSiembra(resultado: ResultadoDeLaSiembra): string {
  if (resultado.estado === "apagado") return "siembra del perfil: apagada";
  if (resultado.estado === "sin-ficheros") {
    return `siembra del perfil: el arnés «${resultado.harness}» no tiene ficheros que Cauce sepa escribir`;
  }
  if (resultado.estado === "no-entra") {
    return `siembra del perfil: NO se escribió nada, ${resultado.fichero} mide ${resultado.medido} `
      + `y el tope es ${resultado.tope}`;
  }
  const cuenta = new Map<string, number>();
  for (const fichero of resultado.ficheros) {
    cuenta.set(fichero.estado, (cuenta.get(fichero.estado) ?? 0) + 1);
  }
  const partes = [...cuenta].map(([estado, n]) => `${estado}=${n}`).join(" ");
  return `siembra del perfil: ${partes}`;
}

/** El mtime de un fichero, o `-1`. Expuesto para que el llamador pueda cachear sin releer. */
export function marcaDeTiempo(ruta: string): number {
  try {
    return statSync(ruta).mtimeMs;
  } catch {
    return -1;
  }
}
