import {
  measureStrictestUnits, seccion, vinetas, type AgentProfile, type ContextoDeAlias,
} from "./agent-profile.js";
import { bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "./marcas-de-bloque.js";

/**
 * EL GENERADOR DE FICHEROS POR ARNÉS: un perfil -> el contenido de CADA fichero que el arnés lee.
 *
 * ── Por qué existe, y por qué no alcanzaba con el compilador ─────────────────────────────────
 *
 * `componerBloqueDePerfil()` produce UN texto con las siete caras del alias. Eso le sirve a
 * `claude` y a `codex`, que leen un solo fichero. `openclaw` NO: lee una FAMILIA de siete Markdown
 * del espacio de trabajo del agente —medidos contenedor por contenedor el 2026-08-24—, y cada uno
 * responde una pregunta distinta:
 *
 *     SOUL.md       quién es y para qué existe
 *     IDENTITY.md   su identidad y su rol
 *     USER.md       quién es su humano y cómo tratarlo
 *     MEMORY.md     lo que aprendió              <- DEL AGENTE, no nuestro
 *     HEARTBEAT.md  su latido                    <- DEL AGENTE, no nuestro
 *     AGENTS.md     cómo se trabaja acá
 *     TOOLS.md      con qué cuenta
 *
 * Volcar el mismo texto en los siete no es una aproximación: el modelo los lee como igual de
 * autoritativos, así que un `SOUL.md` que hable de tareas le enseña que su identidad son sus
 * tareas, y siete copias de lo mismo gastan siete veces el presupuesto para decir una cosa.
 *
 * ── La regla que gobierna MEMORY y HEARTBEAT ─────────────────────────────────────────────────
 *
 * Son del agente. Si ya existen NO se tocan —ni para fusionar un bloque nuestro—, y si faltan se
 * crean vacíos. Pisarlos es borrarle la memoria a un compañero, y desde dentro del contenedor no
 * hay marcha atrás. `argos`, el director de la flota, no tiene NINGUNO de los siete: para él la
 * siembra es la diferencia entre arrancar con persona y arrancar sin ninguna.
 *
 * ── Determinismo ─────────────────────────────────────────────────────────────────────────────
 *
 * Mismo perfil autorado -> los mismos bytes, siempre. Los hechos dinámicos (permisos, cuotas,
 * destinos y montaje) NO se cachean acá: una revocación no puede dejar al disco afirmando lo
 * contrario. Sin fechas, sin relojes y sin recorrer claves en orden incidental: el reparto es
 * una lista FIJA declarada en el código. No es
 * cosmética — cada byte que cambia solo es una reescritura en cada contenedor de la flota, y con
 * `openclaw` son siete ficheros por alias.
 */

// ── Los topes que declara openclaw ───────────────────────────────────────────────────────────

/**
 * Lo que `openclaw.json` declara: `bootstrapMaxChars` por fichero y `bootstrapTotalMaxChars` en
 * total. Se miden con `measureStrictestUnits`, que es la cuenta UTF-16 — la misma que hace
 * `String.length`, que es como los cuenta `openclaw`, que es JavaScript.
 *
 * NO se miden en bytes, y la diferencia no es teórica: con castellano acentuado los bytes
 * SOBREESTIMAN (una `á` son 2 bytes y 1 unidad), así que medir bytes rechazaría ficheros que sí
 * entran; y con un emoji fuera del BMP los puntos de código SUBESTIMAN (1 punto, 2 unidades), así
 * que medir puntos de código dejaría pasar ficheros que no entran. La única cuenta que coincide
 * con la del arnés es la UTF-16.
 */
export const TOPES_OPENCLAW = { porFichero: 60_000, total: 150_000 } as const;

/** Los siete ficheros de openclaw, en el orden en que se emiten. Es el orden medido en la flota. */
export const FICHEROS_OPENCLAW = [
  "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md",
] as const;

/**
 * Un tope superado, con el fichero y los DOS números.
 *
 * Falla en vez de truncar, y ésa es la decisión del módulo. Truncar en silencio deja una persona a
 * medias —un `SOUL.md` entero y un `IDENTITY.md` cortado en mitad de una frase—, que es peor que no
 * escribir nada: el agente lee lo truncado como si fuera todo lo que hay. Y lleva el nombre del
 * fichero y los dos números porque «no entra» sobre siete ficheros no le dice a nadie qué recortar.
 */
export class ErrorDeTopeDelArnes extends Error {
  constructor(
    readonly fichero: string,
    readonly medido: number,
    readonly tope: number,
  ) {
    super(
      fichero === "total"
        ? `los ficheros del arnés suman ${medido} unidades y el tope total es ${tope}`
        : `${fichero} mide ${medido} unidades y el tope por fichero es ${tope}`,
    );
    this.name = "ErrorDeTopeDelArnes";
  }
}

// ── La forma de lo que se genera ─────────────────────────────────────────────────────────────

/** Cómo se trata un fichero que ya está en el disco del contenedor. */
export type PoliticaDeFichero =
  /** Se fusiona nuestro bloque conservando byte a byte todo lo de fuera. */
  | "bloque-gestionado"
  /** Es del agente: si existe no se toca; si falta se crea vacío. */
  | "solo-si-falta";

export interface FicheroGenerado {
  readonly nombre: string;
  readonly politica: PoliticaDeFichero;
  /** El contenido COMPLETO que tiene que quedar en el disco. */
  readonly texto: string;
  /** `false` cuando lo que hay en el disco ya es esto: no hay nada que escribir. */
  readonly escribir: boolean;
}

/** Los nombres que le tocan a un arnés, sin generar nada. Un arnés desconocido no recibe ninguno. */
export function nombresDelArnes(harness: string): readonly string[] {
  if (harness === "claude") return ["CLAUDE.md"];
  if (harness === "codex") return ["AGENTS.md"];
  if (harness === "openclaw") return [...FICHEROS_OPENCLAW];
  return [];
}

// ── EL REPARTO ───────────────────────────────────────────────────────────────────────────────

/**
 * Qué cara del perfil va en cada uno de los siete de openclaw.
 *
 * Está escrito como una tabla y no como una cadena de `if` para que el reparto sea legible de un
 * vistazo y para que el determinismo sea estructural: cambiar qué va dónde exige cambiar esta
 * tabla, no puede pasar por accidente al reordenar código.
 *
 * Los hechos dinámicos no caen en ningún fichero. Autorización, destinos y cuotas cambian sin una
 * edición del perfil y se entregan/validan por sus superficies vivas; materializarlos acá los
 * convertiría en una segunda fuente de verdad obsoleta.
 */
function bloqueDeFichero(nombre: string, perfil: AgentProfile): string {
  if (nombre === "SOUL.md") {
    return unir([seccion("Identidad y propósito", perfil.purpose ?? undefined)]);
  }
  if (nombre === "IDENTITY.md") {
    return unir([seccion("Rol", perfil.role_summary ?? undefined)]);
  }
  if (nombre === "USER.md") {
    return unir([seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined)]);
  }
  if (nombre === "AGENTS.md") {
    /*
     * Sólo reglas autoradas y estables. Los permisos y el inventario alcanzable se resuelven en
     * cada operación/entrega; escribir aquí una fotografía los convertiría en autoridad rancia.
     */
    const autorado = unir([
      seccion("Responsabilidades",
        perfil.responsibilities.length > 0 ? vinetas(perfil.responsibilities) : undefined),
      seccion("Restricciones",
        perfil.restrictions.length > 0 ? vinetas(perfil.restrictions) : undefined),
      seccion("Instrucciones fijas de funcionamiento",
        perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
    ]);
    if (autorado.length === 0) return "";
    return autorado;
  }
  if (nombre === "TOOLS.md") {
    // Sólo herramientas declaradas. Capacidades y cuotas observadas no se congelan en disco.
    if (perfil.tools.length === 0) return "";
    return seccion("Herramientas", vinetas(perfil.tools)) ?? "";
  }
  // MEMORY.md y HEARTBEAT.md no reciben nada nuestro: son del agente.
  return "";
}

/** Bloque único de Claude/Codex: sólo lo autorado, nunca una fotografía de hechos dinámicos. */
function bloqueUnico(perfil: AgentProfile): string {
  const rol = unir([
    perfil.role_summary ?? undefined,
    perfil.responsibilities.length > 0
      ? `Responsabilidades:\n${vinetas(perfil.responsibilities)}`
      : undefined,
    perfil.restrictions.length > 0
      ? `Restricciones:\n${vinetas(perfil.restrictions)}`
      : undefined,
  ]);
  return unir([
    seccion("Identidad y propósito", perfil.purpose ?? undefined),
    seccion("Rol, responsabilidades y restricciones", rol),
    seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined),
    seccion("Herramientas", perfil.tools.length > 0 ? vinetas(perfil.tools) : undefined),
    seccion(
      "Instrucciones fijas de funcionamiento",
      perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined,
    ),
  ]);
}

function unir(partes: readonly (string | undefined)[]): string {
  return partes.filter((parte): parte is string => parte !== undefined && parte.trim().length > 0)
    .join("\n\n");
}

/**
 * Los ficheros que le tocan a un arnés, ya fusionados contra lo que hay en el disco.
 *
 * `existentes` mapea nombre -> contenido actual; un nombre ausente significa que el fichero no
 * está. Se pasa de fuera y no se lee acá a propósito: este módulo es puro y determinista, y quien
 * sabe dónde está el espacio de trabajo del agente es el adaptador, que lo mide del proceso.
 *
 * LANZA `ErrorDeTopeDelArnes` antes de devolver nada si algún fichero —o la suma— se pasa del tope
 * del arnés. Lanza en vez de devolver un resultado parcial porque una persona a medias es peor que
 * ninguna: siete ficheros de los que cuatro están al día y tres no se contradicen entre sí, y el
 * modelo no tiene forma de saber cuál creer.
 */
export function ficherosDelArnes(
  harness: string,
  contexto: ContextoDeAlias,
  existentes: ReadonlyMap<string, string> = new Map(),
): readonly FicheroGenerado[] {
  const nombres = nombresDelArnes(harness);
  const generados: FicheroGenerado[] = [];

  for (const nombre of nombres) {
    const previo = existentes.get(nombre);

    // MEMORY y HEARTBEAT: del agente. Si están, se devuelven TAL CUAL y no se escriben.
    if (esDelAgente(harness, nombre)) {
      generados.push({
        nombre, politica: "solo-si-falta",
        texto: previo ?? "",
        escribir: previo === undefined,
      });
      continue;
    }

    // El fichero único de claude/codex lleva el perfil ENTERO: ese arnés no tiene dónde repartirlo.
    const cuerpo = harness === "openclaw"
      ? bloqueDeFichero(nombre, contexto.perfil)
      : bloqueUnico(contexto.perfil);
    const bloque = cuerpo.trim().length === 0 ? "" : `${renglonDeDueno(contexto.perfil)}\n${cuerpo}`;

    /*
     * Sin bloque no se emite un encabezado hueco — un encabezado sin nada debajo le enseña al
     * agente que el sistema no sabe la respuesta, que es peor que no preguntar—, PERO el bloque
     * que ya estuviera escrito SÍ se retira.
     *
     * La diferencia es todo el contrato de esta tabla. «La base es la fuente de verdad y el
     * fichero se GENERA desde ella» significa que borrar un campo en la consola tiene que borrarlo
     * del fichero. Devolviendo `escribir: false` sobre un fichero que todavía dice lo viejo, el
     * generador AFIRMA que está al día mientras el agente sigue leyendo el propósito que alguien
     * quitó — y no hay error, ni aviso, ni forma de enterarse. Medido: borrado `purpose`, `SOUL.md`
     * seguía diciendo el propósito viejo; borrado `human_brief`, `USER.md` seguía nombrando al
     * humano viejo.
     *
     * Retirar es quitar EL BLOQUE, no vaciar el fichero: lo que una persona escribiera fuera de
     * las marcas se conserva byte a byte, igual que al escribir.
     */
    const anterior = previo === undefined ? undefined : bloqueDePerfil(previo);

    /*
     * La guarda corre ANTES de escribir Y antes de retirar. Un perfil vacío de `atlas` no autoriza
     * a borrar el bloque de `kratos` del AGENTS.md compartido. Un bloque sin dueño tampoco se
     * atribuye por descarte: si la procedencia es ambigua, se conserva.
     */
    if (anterior !== undefined && !esDelMismoAlias(anterior, contexto.perfil)) {
      generados.push({
        nombre, politica: "bloque-gestionado", texto: previo ?? "", escribir: false,
      });
      continue;
    }

    if (bloque.trim().length === 0) {
      const teniaBloque = anterior !== undefined;
      if (!teniaBloque) {
        generados.push({
          nombre, politica: "bloque-gestionado", texto: previo ?? "", escribir: false,
        });
        continue;
      }
      const limpio = sinBloqueDePerfil(previo ?? "");
      generados.push({
        nombre, politica: "bloque-gestionado", texto: limpio, escribir: limpio !== previo,
      });
      continue;
    }

    const texto = conBloqueDePerfil(previo ?? "", bloque);
    generados.push({
      nombre, politica: "bloque-gestionado", texto, escribir: texto !== previo,
    });
  }

  comprobarTopes(harness, generados);
  return generados;
}

/**
 * El renglón que dice DE QUIÉN es este bloque. Va dentro del bloque y como primera línea.
 *
 * Es lo que hace posible la guarda de dueño: sin él, dos alias que comparten `$HOME` —`kratos` y
 * `atlas`, mismo inodo medido— no tienen forma de distinguir «mi bloque de ayer» de «el bloque del
 * otro», y la única opción segura sería no escribir nunca.
 *
 * Va en comentario HTML porque en Markdown no se ve al leer, igual que las marcas.
 */
function renglonDeDueno(perfil: AgentProfile): string {
  return `<!-- alias: ${perfil.tenant_id}/${perfil.alias} -->`;
}

/** El alias que declara un bloque, o `undefined` si no lo declara. */
function duenoDelBloque(bloque: string): string | undefined {
  return /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/.exec(bloque)?.[1];
}

/**
 * ¿El bloque que hay en el disco es de este mismo alias?
 *
 * Un bloque SIN dueño declarado NO cuenta como nuestro. Puede parecer duro, pero es lo correcto
 * hoy: `ficherosDelArnes` no tiene todavía ningún llamador en producción, así que no existe ni un
 * bloque B escrito en la flota. Aceptar los que no se identifican sólo serviría para reabrir el
 * agujero de `kratos`/`atlas` sin ganar nada.
 */
function esDelMismoAlias(anterior: string, perfil: AgentProfile): boolean {
  const suyo = duenoDelBloque(anterior);
  return suyo !== undefined && suyo === `${perfil.tenant_id}/${perfil.alias}`;
}

/** `MEMORY.md` y `HEARTBEAT.md` de openclaw, y nada más. */
function esDelAgente(harness: string, nombre: string): boolean {
  return harness === "openclaw" && (nombre === "MEMORY.md" || nombre === "HEARTBEAT.md");
}

/**
 * Los topes, comprobados sobre el texto FINAL —el que va a quedar en el disco—, no sobre el bloque.
 *
 * Sobre el final porque es lo que el arnés carga: un bloque de 10.000 dentro de un fichero que una
 * persona ya llenó con 55.000 pasa de largo si se mide sólo lo nuestro, y el que no arranca es el
 * agente. Sólo se aplican a `openclaw`, que es el único arnés que declara topes; inventárselos a
 * `claude` sería ponerle un límite que su arnés no tiene.
 */
function comprobarTopes(harness: string, ficheros: readonly FicheroGenerado[]): void {
  if (harness !== "openclaw") return;
  let total = 0;
  for (const fichero of ficheros) {
    /*
     * LOS FICHEROS DEL AGENTE NO ENTRAN EN LA CUENTA, y la razón es de daño, no de aritmética.
     *
     * `MEMORY.md` es del agente, no tiene tope y CRECE: es lo que va aprendiendo. Contándolo, un
     * alias con memoria larga bloquea la siembra de los SIETE ficheros —incluida su identidad— con
     * un error que además NOMBRA a `MEMORY.md`, o sea que invita al operador a podar la memoria de
     * un compañero para desatascar el despliegue. Ese borrado es irreversible desde dentro del
     * contenedor y es exactamente el acto que este módulo declara catastrófico tres párrafos más
     * arriba.
     *
     * Además no habría nada que recortar: no escribimos un solo byte de ellos. El tope del arnés
     * existe para proteger lo que NOSOTROS metemos.
     */
    if (fichero.politica === "solo-si-falta") continue;
    const medido = measureStrictestUnits(fichero.texto);
    if (medido > TOPES_OPENCLAW.porFichero) {
      throw new ErrorDeTopeDelArnes(fichero.nombre, medido, TOPES_OPENCLAW.porFichero);
    }
    total += medido;
  }
  if (total > TOPES_OPENCLAW.total) {
    throw new ErrorDeTopeDelArnes("total", total, TOPES_OPENCLAW.total);
  }
}
