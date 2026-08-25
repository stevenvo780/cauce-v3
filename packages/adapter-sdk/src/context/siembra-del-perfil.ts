import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, ftruncateSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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
  /** El arnés no es de los que Cauce sabe escribir. */
  | { readonly estado: "sin-ficheros"; readonly harness: string }
  /** El arnés sí tiene ficheros, pero su home/workspace medido falta o no es una ruta absoluta. */
  | { readonly estado: "sin-directorio"; readonly harness: string }
  /** Un fichero —o la suma— se pasa del tope del arnés. NO se escribe ninguno. */
  | { readonly estado: "no-entra"; readonly fichero: string; readonly medido: number; readonly tope: number }
  | { readonly estado: "hecho"; readonly ficheros: readonly ResultadoDeFichero[] };

/** El disco, inyectable para poder probar la siembra sin tocar el sistema de ficheros. */
export interface DiscoDelArnes {
  /** `undefined` si el fichero no está. Cualquier otro fallo se propaga. */
  leer(ruta: string): string | undefined;
  escribir(ruta: string, contenido: string): void;
  /** Prepara el lote entero y revierte lo ya aplicado antes de propagar cualquier fallo. */
  escribirLote(escrituras: readonly EscrituraDelArnes[]): void;
}

export interface EscrituraDelArnes {
  readonly ruta: string;
  readonly contenido: string;
}

interface FicheroPreparado {
  readonly ruta: string;
  readonly rutaAnclada: string;
  readonly contenido: string;
  readonly descriptor: number;
  readonly descriptorDelDirectorio: number;
  readonly rutaDelDirectorio: string;
  readonly devDelDirectorio: number;
  readonly inoDelDirectorio: number;
  readonly previo: Buffer | undefined;
  readonly temporal: string | undefined;
  readonly dev: number;
  readonly ino: number;
  tocado: boolean;
  enlazado: boolean;
}

function esErrorConCodigo(error: unknown, codigo: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === codigo;
}

function exigirFicheroRegular(descriptor: number): { readonly dev: number; readonly ino: number } {
  const estado = fstatSync(descriptor);
  if (!estado.isFile()) throw new Error("el destino del perfil no es un fichero regular");
  return { dev: estado.dev, ino: estado.ino };
}

interface DirectorioAnclado {
  readonly descriptor: number;
  readonly ruta: string;
  readonly dev: number;
  readonly ino: number;
}

function rutaDelDescriptor(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

function comprobarSoporteDeDirfd(descriptor: number): void {
  let comprobacion: number | undefined;
  try {
    /* Aquí sí se sigue deliberadamente el magic-link al descriptor que acabamos de abrir. */
    comprobacion = openSync(rutaDelDescriptor(descriptor), constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    throw new Error("no se puede anclar el directorio del perfil mediante /proc/self/fd", {
      cause: error,
    });
  } finally {
    if (comprobacion !== undefined) closeSync(comprobacion);
  }
}

/**
 * Equivalente práctico a recorrer con `openat(O_NOFOLLOW)`, que Node no expone directamente.
 * Cada componente se abre relativo al descriptor del anterior mediante `/proc/self/fd`; por eso
 * sustituir un padre mientras avanzamos no puede redirigir el siguiente open. Si procfs no está
 * montado, falla cerrado. Los directorios bind-mounted siguen siendo directorios regulares y no se
 * rechazan; los symlinks sí. Residual: Node no puede impedir que otro proceso cambie el NOMBRE del
 * directorio después de que esta función termine; eso puede volver inaccesible el resultado, pero
 * no redirige ninguna E/S ya anclada. Evitar también eso requiere cooperación/lock externo u
 * `openat2`, que Node 22 no expone.
 */
function abrirDirectorioAnclado(ruta: string, crear: boolean): DirectorioAnclado {
  const absoluta = resolve(ruta);
  const raiz = parse(absoluta).root;
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let descriptor = openSync(raiz, flags);

  try {
    comprobarSoporteDeDirfd(descriptor);
    const resto = relative(raiz, absoluta);
    const componentes = resto.length === 0 ? [] : resto.split(sep).filter(Boolean);
    for (const componente of componentes) {
      const anclada = join(rutaDelDescriptor(descriptor), componente);
      let siguiente: number;
      try {
        siguiente = openSync(anclada, flags);
      } catch (error) {
        if (!crear || !esErrorConCodigo(error, "ENOENT")) throw error;
        try {
          mkdirSync(anclada, { mode: 0o700 });
        } catch (creacion) {
          if (!esErrorConCodigo(creacion, "EEXIST")) throw creacion;
        }
        siguiente = openSync(anclada, flags);
      }
      const estado = fstatSync(siguiente);
      if (!estado.isDirectory()) {
        closeSync(siguiente);
        throw new Error("un componente padre del perfil no es un directorio regular");
      }
      closeSync(descriptor);
      descriptor = siguiente;
    }

    const estado = fstatSync(descriptor);
    if (!estado.isDirectory()) throw new Error("el padre del perfil no es un directorio regular");
    return { descriptor, ruta: absoluta, dev: estado.dev, ino: estado.ino };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function comprobarDirectorioAnclado(preparado: FicheroPreparado): void {
  const actual = abrirDirectorioAnclado(preparado.rutaDelDirectorio, false);
  try {
    if (actual.dev !== preparado.devDelDirectorio || actual.ino !== preparado.inoDelDirectorio) {
      throw new Error("el directorio padre del perfil cambió durante la siembra");
    }
  } finally {
    closeSync(actual.descriptor);
  }
}

function reemplazarContenido(descriptor: number, contenido: string | Buffer): void {
  const bytes = typeof contenido === "string" ? Buffer.from(contenido, "utf8") : contenido;
  ftruncateSync(descriptor, 0);
  let escritos = 0;
  while (escritos < bytes.length) {
    const cantidad = writeSync(descriptor, bytes, escritos, bytes.length - escritos, escritos);
    if (cantidad === 0) throw new Error("la escritura del perfil no avanzó");
    escritos += cantidad;
  }
  fsyncSync(descriptor);
}

function prepararFichero(escritura: EscrituraDelArnes): FicheroPreparado {
  const ruta = resolve(escritura.ruta);
  const directorio = abrirDirectorioAnclado(dirname(ruta), true);
  const rutaAnclada = join(rutaDelDescriptor(directorio.descriptor), basename(ruta));
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  let descriptor: number;
  try {
    descriptor = openSync(rutaAnclada, flags);
  } catch (error) {
    if (!esErrorConCodigo(error, "ENOENT")) {
      closeSync(directorio.descriptor);
      throw error;
    }

    /*
     * Un fichero nuevo se prepara completo fuera del nombre final y aparece con `link(2)`, que
     * falla si alguien creó el destino en la carrera. No se hace `rename` sobre uno existente.
    */
    const temporal = join(rutaDelDescriptor(directorio.descriptor), `.cauce-perfil-${randomUUID()}.tmp`);
    try {
      descriptor = openSync(
        temporal,
        flags | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (preparacion) {
      closeSync(directorio.descriptor);
      throw preparacion;
    }
    try {
      const identidad = exigirFicheroRegular(descriptor);
      reemplazarContenido(descriptor, escritura.contenido);
      return {
        ...escritura,
        ruta,
        rutaAnclada,
        descriptor,
        descriptorDelDirectorio: directorio.descriptor,
        rutaDelDirectorio: directorio.ruta,
        devDelDirectorio: directorio.dev,
        inoDelDirectorio: directorio.ino,
        previo: undefined,
        temporal,
        ...identidad,
        tocado: false,
        enlazado: false,
      };
    } catch (preparacion) {
      closeSync(descriptor);
      try { unlinkSync(temporal); } catch { /* el error original conserva la causa útil */ }
      closeSync(directorio.descriptor);
      throw preparacion;
    }
  }

  try {
    const identidad = exigirFicheroRegular(descriptor);
    const previo = readFileSync(descriptor);
    return {
      ...escritura,
      ruta,
      rutaAnclada,
      descriptor,
      descriptorDelDirectorio: directorio.descriptor,
      rutaDelDirectorio: directorio.ruta,
      devDelDirectorio: directorio.dev,
      inoDelDirectorio: directorio.ino,
      previo,
      temporal: undefined,
      ...identidad,
      tocado: false,
      enlazado: false,
    };
  } catch (error) {
    closeSync(descriptor);
    closeSync(directorio.descriptor);
    throw error;
  }
}

function retirarFicheroCreado(preparado: FicheroPreparado): void {
  const estado = lstatSync(preparado.rutaAnclada);
  if (!estado.isFile() || estado.dev !== preparado.dev || estado.ino !== preparado.ino) {
    throw new Error("el destino creado cambió durante el rollback; no se retiró");
  }
  unlinkSync(preparado.rutaAnclada);
}

/**
 * Transacción local con preflight y rollback verificable. Los nombres nuevos aparecen de una vez;
 * los inodes existentes se conservan. Esto NO promete visibilidad atómica entre varios ficheros:
 * lograrla exigiría que el arnés leyera una versión/directorio conmutado, protocolo que hoy no
 * existe. Sí promete no devolver un fallo sin antes intentar restaurar cada destino tocado.
 */
function escribirLoteReal(escrituras: readonly EscrituraDelArnes[]): void {
  const rutas = new Set(escrituras.map((escritura) => resolve(escritura.ruta)));
  if (rutas.size !== escrituras.length) throw new Error("el lote del perfil repite un destino");

  const preparados: FicheroPreparado[] = [];
  try {
    /* PREFLIGHT COMPLETO: no se modifica un destino hasta que todos abrieron y validaron. */
    for (const escritura of escrituras) preparados.push(prepararFichero(escritura));
    for (const preparado of preparados) comprobarDirectorioAnclado(preparado);

    for (const preparado of preparados) {
      if (preparado.temporal !== undefined) {
        linkSync(preparado.temporal, preparado.rutaAnclada);
        preparado.enlazado = true;
        unlinkSync(preparado.temporal);
      } else {
        /*
         * Los targets existentes pueden ser bind mounts. Se escribe por el descriptor ya
         * validado para conservar su inode; un rename "atómico" rompería la vista montada.
         */
        preparado.tocado = true;
        reemplazarContenido(preparado.descriptor, preparado.contenido);
      }
    }
    /* Detecta un swap de padres ocurrido durante el commit; el catch restaura por los dirfds. */
    for (const preparado of preparados) comprobarDirectorioAnclado(preparado);
  } catch (error) {
    const fallosDeRollback: string[] = [];
    for (const preparado of [...preparados].reverse()) {
      try {
        if (preparado.enlazado) retirarFicheroCreado(preparado);
        else if (preparado.tocado && preparado.previo !== undefined) {
          reemplazarContenido(preparado.descriptor, preparado.previo);
        }
      } catch {
        fallosDeRollback.push(preparado.ruta);
      }
    }
    if (fallosDeRollback.length > 0) {
      throw new Error(`falló la siembra y también el rollback de ${fallosDeRollback.length} fichero(s)`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    for (const preparado of preparados) {
      try { closeSync(preparado.descriptor); } catch { /* no oculta el resultado del lote */ }
      if (preparado.temporal !== undefined) {
        try { unlinkSync(preparado.temporal); } catch (error) {
          if (!esErrorConCodigo(error, "ENOENT")) {
            /* El temporal no es visible al arnés; la próxima higiene puede retirarlo. */
          }
        }
      }
      try { closeSync(preparado.descriptorDelDirectorio); } catch { /* ya no se usa */ }
    }
  }
}

export const discoReal: DiscoDelArnes = {
  leer(ruta) {
    let directorio: DirectorioAnclado | undefined;
    let descriptor: number | undefined;
    try {
      const absoluta = resolve(ruta);
      directorio = abrirDirectorioAnclado(dirname(absoluta), false);
      descriptor = openSync(
        join(rutaDelDescriptor(directorio.descriptor), basename(absoluta)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      exigirFicheroRegular(descriptor);
      return readFileSync(descriptor, "utf8");
    } catch (error) {
      if (esErrorConCodigo(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (directorio !== undefined) closeSync(directorio.descriptor);
    }
  },
  escribir(ruta, contenido) {
    escribirLoteReal([{ ruta, contenido }]);
  },
  escribirLote: escribirLoteReal,
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
  const absoluta = (valor: string | undefined): string | undefined => {
    if (valor === undefined || valor.trim().length === 0 || !isAbsolute(valor)) return undefined;
    return resolve(valor);
  };
  const home = absoluta(entorno.HOME);
  if (harness === "claude") {
    if (entorno.CLAUDE_CONFIG_DIR !== undefined) return absoluta(entorno.CLAUDE_CONFIG_DIR);
    return home === undefined ? undefined : join(home, ".claude");
  }
  if (harness === "codex") {
    if (entorno.CODEX_HOME !== undefined) return absoluta(entorno.CODEX_HOME);
    return home === undefined ? undefined : join(home, ".codex");
  }
  if (harness === "openclaw") {
    /*
     * `CAUCE_OPENCLAW_WORKSPACE` primero porque el espacio de trabajo de un agente openclaw NO es
     * su `$HOME`: es el directorio donde el arnés carga su familia de siete. Sin la variable no se
     * adivina —`$HOME` sería casi siempre el sitio equivocado, y sembrar siete Markdown en el
     * sitio equivocado es peor que no sembrar—, así que se devuelve `undefined` y no se toca nada.
     */
    return absoluta(entorno.CAUCE_OPENCLAW_WORKSPACE);
  }
  return undefined;
}

export interface OpcionesDeSiembra {
  /** Sin esto no se escribe NADA. El cliente real lo deja activo salvo `CAUCE_SEMBRAR_PERFIL=0`. */
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
  if (directorio === undefined) return { estado: "sin-directorio", harness };

  const disco = opciones.disco ?? discoReal;

  // Lo que hay AHORA en el disco. Sólo ENOENT significa «no está». Si uno no se puede leer, no se
  // genera ni escribe NINGUNO: completar seis de siete OpenClaw deja una persona contradictoria y
  // tratar EACCES/ELOOP como ausencia puede sobrescribir justamente lo que no pudimos inspeccionar.
  const existentes = new Map<string, string>();
  const erroresDeLectura = new Map<string, string>();
  for (const nombre of nombres) {
    try {
      const contenido = disco.leer(join(directorio, nombre));
      if (contenido !== undefined) existentes.set(nombre, contenido);
    } catch (error) {
      erroresDeLectura.set(nombre, error instanceof Error ? error.message : String(error));
    }
  }
  if (erroresDeLectura.size > 0) {
    return {
      estado: "hecho",
      ficheros: nombres.map((nombre) => ({
        nombre,
        estado: "no-se-pudo-escribir" as const,
        motivo: erroresDeLectura.has(nombre)
          ? `no se pudo leer el fichero existente: ${erroresDeLectura.get(nombre)}`
          : "lote cancelado porque otro fichero no se pudo leer",
      })),
    };
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

  const porNombre = new Map<string, ResultadoDeFichero>();
  const escrituras: EscrituraDelArnes[] = [];
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
      porNombre.set(fichero.nombre, {
        nombre: fichero.nombre,
        estado: ajeno ? "ocupado-por-otro-alias" : "ya-estaba",
      });
      continue;
    }
    escrituras.push({ ruta: join(directorio, fichero.nombre), contenido: fichero.texto });
  }

  if (escrituras.length > 0) {
    try {
      /* Un solo commit lógico: el disco preflighta TODO y revierte antes de lanzar. */
      disco.escribirLote(escrituras);
      for (const fichero of generados.filter((generado) => generado.escribir)) {
        porNombre.set(fichero.nombre, { nombre: fichero.nombre, estado: "escrito" });
      }
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      for (const fichero of generados.filter((generado) => generado.escribir)) {
        porNombre.set(fichero.nombre, {
          nombre: fichero.nombre,
          estado: "no-se-pudo-escribir",
          motivo,
        });
      }
    }
  }

  return {
    estado: "hecho",
    ficheros: generados.map((fichero) => {
      const resultado = porNombre.get(fichero.nombre);
      return resultado ?? {
        nombre: fichero.nombre,
        estado: "no-se-pudo-escribir" as const,
        motivo: "el lote no produjo un resultado para este fichero",
      };
    }),
  };
}

/** Un renglón para el registro, legible por una persona. Nunca lleva el contenido del fichero. */
export function resumenDeLaSiembra(resultado: ResultadoDeLaSiembra): string {
  if (resultado.estado === "apagado") return "siembra del perfil: apagada";
  if (resultado.estado === "sin-ficheros") {
    return `siembra del perfil: el arnés «${resultado.harness}» no tiene ficheros que Cauce sepa escribir`;
  }
  if (resultado.estado === "sin-directorio") {
    return `siembra del perfil: el arnés «${resultado.harness}» no tiene un directorio absoluto medido`;
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
