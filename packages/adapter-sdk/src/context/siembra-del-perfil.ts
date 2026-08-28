import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, ftruncateSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  ErrorDeTopeDelArnes, PREFIJO_REVISION_PERFIL, bloqueDePerfil, ficherosDelArnes, nombresDelArnes,
  revisionDelPerfil, type ContextoDeAlias,
  type FicheroGenerado,
} from "@cauce/protocol";

/**
 * Writes the alias profile into the files its harness reads (CLAUDE.md, AGENTS.md, etc.).
 *
 * - Executed by the adapter (not the gateway) because it runs inside the container with access to `$HOME`.
 * - Invoked once per connection (in the hello), not per delivery.
 * - Never throws: a failure leaves the previous file intact and returns a diagnostic report.
 */

/** What happened with each file. Goes to the log; the turn continues regardless. */
export type ResultadoDeFichero =
  | { readonly nombre: string; readonly estado: "escrito" }
  | { readonly nombre: string; readonly estado: "ya-estaba" }
  /** Existing block belongs to another alias; not overwritten. */
  | { readonly nombre: string; readonly estado: "ocupado-por-otro-alias" }
  | { readonly nombre: string; readonly estado: "no-se-pudo-escribir"; readonly motivo: string };

export type ResultadoDeLaSiembra =
  | { readonly estado: "apagado" }
  /** Harness is not one Cauce knows how to write. */
  | { readonly estado: "sin-ficheros"; readonly harness: string }
  /** Harness has files, but its measured home/workspace is missing or not an absolute path. */
  | { readonly estado: "sin-directorio"; readonly harness: string }
  /** A file —or the sum— exceeds the harness cap. NONE is written. */
  | { readonly estado: "no-entra"; readonly fichero: string; readonly medido: number; readonly tope: number }
  | { readonly estado: "hecho"; readonly ficheros: readonly ResultadoDeFichero[] };

/** Disk, injectable so seeding can be tested without touching the file system. */
export interface DiscoDelArnes {
  /** `undefined` if the file is not there. Any other failure propagates. */
  leer(ruta: string, maximoDeBytes?: number): string | undefined;
  escribir(ruta: string, contenido: string): void;
  /** Prepares the entire batch and reverts what was applied before propagating any failure. */
  escribirLote(escrituras: readonly EscrituraDelArnes[]): void;
}

export interface EscrituraDelArnes {
  readonly ruta: string;
  readonly contenido: string;
  readonly contenidoPrevio?: string;
}

interface FicheroPreparado {
  readonly ruta: string;
  readonly rutaAnclada: string;
  readonly contenido: string;
  readonly contenidoPrevio?: string;
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
    /* The magic-link to the descriptor we just opened IS deliberately followed here. */
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
 * Practical equivalent to walking with `openat(O_NOFOLLOW)`, which Node does not expose directly.
 * Each component is opened relative to the previous descriptor via `/proc/self/fd`; that's why
 * swapping a parent while walking cannot redirect the next open. If procfs is not mounted, it
 * fails closed. Bind-mounted directories stay regular and are not rejected; symlinks are.
 * Residual: Node cannot stop another process from RENAMING the directory after this function
 * returns; that can make the result inaccessible, but does not redirect any already-anchored I/O.
 * Avoiding that too requires external cooperation/lock or `openat2`, which Node 22 doesn't expose.
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

function leerContenido(descriptor: number, maximoDeBytes?: number): Buffer {
  const inicial = fstatSync(descriptor);
  if (maximoDeBytes !== undefined && inicial.size > maximoDeBytes) {
    throw new Error(`el fichero excede el tope seguro de ${String(maximoDeBytes)} bytes`);
  }
  const contenido = Buffer.alloc(inicial.size);
  let leidos = 0;
  while (leidos < contenido.length) {
    const cantidad = readSync(
      descriptor,
      contenido,
      leidos,
      contenido.length - leidos,
      leidos,
    );
    if (cantidad === 0) break;
    leidos += cantidad;
  }
  const final = fstatSync(descriptor);
  if (leidos !== contenido.length || final.size !== inicial.size) {
    throw new Error("el destino cambió mientras se leían sus bytes acreditados");
  }
  return contenido;
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
    if (escritura.contenidoPrevio !== undefined) {
      closeSync(directorio.descriptor);
      throw new Error("el destino cambió desde la lectura acreditada");
    }

/*
     * A new file is prepared fully outside the final name and appears with `link(2)`, which fails
     * if someone created the destination in the race. No `rename` is done over an existing one.
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
    if (escritura.contenidoPrevio !== undefined && fstatSync(descriptor).nlink !== 1) {
      throw new Error("el destino del perfil tiene enlaces duros inesperados");
    }
    const previo = leerContenido(descriptor);
    if (escritura.contenidoPrevio !== undefined
      && !previo.equals(Buffer.from(escritura.contenidoPrevio, "utf8"))) {
      throw new Error("el destino cambió desde la lectura acreditada");
    }
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
 * Local transaction with verifiable preflight and rollback. New names appear at once; existing
 * inodes are preserved. This does NOT promise atomic visibility across multiple files: achieving
 * it would require the harness to read a switched version/directory, a protocol that does not
 * exist today. It does promise not to return a failure without first trying to restore each
 * touched destination.
 */
function escribirLoteReal(escrituras: readonly EscrituraDelArnes[]): void {
  const rutas = new Set(escrituras.map((escritura) => resolve(escritura.ruta)));
  if (rutas.size !== escrituras.length) throw new Error("el lote del perfil repite un destino");

  const preparados: FicheroPreparado[] = [];
  try {
    /* FULL PREFLIGHT: no destination is modified until all have opened and validated. */
    for (const escritura of escrituras) preparados.push(prepararFichero(escritura));
    for (const preparado of preparados) comprobarDirectorioAnclado(preparado);

    for (const preparado of preparados) {
      if (preparado.temporal !== undefined) {
        linkSync(preparado.temporal, preparado.rutaAnclada);
        preparado.enlazado = true;
        unlinkSync(preparado.temporal);
      } else {
        /*
         * Existing targets may be bind mounts. Write via the already-validated descriptor to
         * preserve their inode; an "atomic" rename would break the mounted view.
         */
        if (preparado.contenidoPrevio !== undefined) {
          const current = leerContenido(preparado.descriptor);
          if (!current.equals(Buffer.from(preparado.contenidoPrevio, "utf8"))) {
            throw new Error("el destino cambió antes de confirmar la escritura");
          }
        }
        preparado.tocado = true;
        reemplazarContenido(preparado.descriptor, preparado.contenido);
      }
    }
    /* Detect a parent swap that happened during commit; the catch restores via the dirfds. */
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
            /* The temp is not visible to the harness; next hygiene can remove it. */
          }
        }
      }
      try { closeSync(preparado.descriptorDelDirectorio); } catch { /* ya no se usa */ }
    }
  }
}

export const discoReal: DiscoDelArnes = {
  leer(ruta, maximoDeBytes) {
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
      return leerContenido(descriptor, maximoDeBytes).toString("utf8");
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

export function escribirEnDiscoRealSiCoincide(
  ruta: string,
  contenidoPrevio: string,
  contenido: string,
): void {
  escribirLoteReal([{ ruta, contenido, contenidoPrevio }]);
}

/**
 * Resolves the harness directory: `$CLAUDE_CONFIG_DIR`/`$HOME/.claude` for claude,
 * `$CODEX_HOME`/`$HOME/.codex` for codex, the agent's workspace for openclaw.
 * `CLAUDE_CONFIG_DIR` takes priority over `$HOME` to isolate aliases sharing a container.
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
     * `CAUCE_OPENCLAW_WORKSPACE` first because an openclaw agent's workspace is NOT its `$HOME`:
     * it's the directory where the harness loads its family of seven. Without the variable we
     * don't guess —`$HOME` would almost always be the wrong place, and seeding seven Markdowns in
     * the wrong place is worse than not seeding—, so `undefined` is returned and nothing is touched.
     */
    return absoluta(entorno.CAUCE_OPENCLAW_WORKSPACE);
  }
  return undefined;
}

export interface OpcionesDeSiembra {
  /** Without this NOTHING is written. The real client leaves it on unless `CAUCE_SEMBRAR_PERFIL=0`. */
  readonly habilitado: boolean;
  readonly disco?: DiscoDelArnes;
  readonly entorno?: NodeJS.ProcessEnv;
}

/**
 * Writes the profile into the harness files. Never throws.
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

  // What is on disk NOW. Only ENOENT means "not there". If one cannot be read, NONE is generated
  // or written: completing six of seven OpenClaw leaves a contradictory persona, and treating
  // EACCES/ELOOP as absence can overwrite exactly what we couldn't inspect.
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
  let revisionNativa: number | undefined;
  try {
    const nombreCanonico = harness === "claude"
      ? "CLAUDE.md"
      : harness === "openclaw" ? "AGENTS.md" : undefined;
    const textoCanonico = nombreCanonico === undefined ? undefined : existentes.get(nombreCanonico);
    revisionNativa = textoCanonico === undefined || !textoCanonico.includes(PREFIJO_REVISION_PERFIL)
      ? undefined
      : revisionDelPerfil(textoCanonico);
    generados = ficherosDelArnes(
      harness,
      contexto,
      existentes,
      revisionNativa === undefined ? {} : { revision: revisionNativa },
    );
  } catch (error) {
    if (error instanceof ErrorDeTopeDelArnes) {
// NONE is written. A half-persona —four files today, three not— contradicts itself, and the
        // model has no way to know which one to believe.
      return { estado: "no-entra", fichero: error.fichero, medido: error.medido, tope: error.tope };
    }
    return { estado: "no-entra", fichero: "desconocido", medido: 0, tope: 0 };
  }

  if (revisionNativa !== undefined
    && generados.some((fichero) => fichero.escribir || !existentes.has(fichero.nombre))) {
    return {
      estado: "hecho",
      ficheros: generados.map((fichero) => ({
        nombre: fichero.nombre,
        estado: "no-se-pudo-escribir" as const,
        motivo: "la proyección revisionada difiere; sólo el publicador durable puede cambiarla",
      })),
    };
  }

  const porNombre = new Map<string, ResultadoDeFichero>();
  const escrituras: EscrituraDelArnes[] = [];
  for (const fichero of generados) {
    if (!fichero.escribir) {
      /*
       * `escribir: false` over a file that ALREADY exists and whose text is NOT ours can only be
       * the owner's guard: `ficherosDelArnes` returns the prior intact when the block belongs to
       * another alias. Distinguishing matters because "already up to date" and "I won't touch it
       * because it's someone else's" are two very different things for whoever reads the log
       * looking for why an alias lacks its profile.
       */
      const previo = existentes.get(fichero.nombre);
      const bloquePrevio = previo === undefined ? undefined : bloqueDePerfil(previo);
      const duenoPrevio = bloquePrevio?.trimStart().split(/\r?\n/u, 1)[0];
      const duenoEsperado = `<!-- alias: ${contexto.perfil.tenant_id}/${contexto.perfil.alias} -->`;
      const ajeno = previo !== undefined && previo === fichero.texto
        && fichero.politica === "bloque-gestionado" && bloquePrevio !== undefined
        && duenoPrevio !== duenoEsperado;
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
      /* One logical commit: the disk preflights EVERYTHING and reverts before throwing. */
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

/** One line for the log, readable by a person. Never carries the file content. */
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
