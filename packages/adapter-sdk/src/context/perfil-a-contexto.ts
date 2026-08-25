import {
  clampToRoleBriefLimit,
  type AgentProfile, type ArnesDelAlias, type ContextoDeAlias, type CuotaDelAlias,
  type HechosDelAlias, type PermisosDelAlias,
} from "@cauce/protocol";
import {
  bloqueEntreMarcas, conBloqueEntreMarcas, resumirContextoFijo, VERSION_CONTEXTO_FIJO,
} from "../harnesses/contexto-fijo.js";

/**
 * EL COMPILADOR DE CONTEXTO: perfil + hechos del arnés -> el texto que va al fichero.
 *
 * ── Qué NO hace, que es el punto ─────────────────────────────────────────────────────────────
 *
 * No inventa la redacción del contrato. La prosa fija —identidad, DEBER PRIMARIO, invariantes de
 * protocolo, mecánicas de delegación— ya existe, está probada y la compone
 * `textoFijoDelSobre()` en `harnesses/shared.ts`. El sello del bloque gestionado es el sha256 de
 * ESE texto exacto: si este módulo lo reformateara —un título delante, una coma cambiada, las
 * secciones en otro orden— el sello no coincidiría nunca, el adaptador seguiría mandando el sobre
 * entero y el ahorro sería exactamente cero, sin un solo error visible.
 *
 * Lo que este módulo compone es LO DEL ALIAS: las siete caras del perfil, en un texto que alimenta
 * la línea `Tu rol:` del preámbulo de identidad. Nada más.
 *
 * ── De dónde sale cada cara ──────────────────────────────────────────────────────────────────
 *
 * Cuatro son AUTORADAS y viven en `agent_profiles` (migración 026): identidad y propósito; rol,
 * responsabilidades y restricciones; herramientas declaradas; instrucciones fijas del alias.
 *
 * Tres son HECHOS y NO se guardan: permisos (`memberships` + `role_policies`), cuotas
 * (`provider_accounts`) y configuración del arnés (`agents` + `harness_definitions`). Llegan como
 * `HechosDelAlias` y se unen acá. Guardarlas como texto autorado sería fabricar una segunda fuente
 * de verdad: el permiso se revoca en la base y el fichero del contenedor sigue diciendo que lo
 * tiene.
 *
 * ── Determinismo ─────────────────────────────────────────────────────────────────────────────
 *
 * Mismo perfil y mismos hechos -> mismos bytes, siempre. Sin fechas, sin relojes, sin `Object.keys`
 * de orden incidental: las secciones se emiten en un orden FIJO declarado en el código, y el JSON
 * de la proyección de openclaw pasa por `serializarEstable`, que ordena las claves. Un compilador
 * no determinista haría que el sello cambiara solo, y cada cambio de sello cuesta una reescritura
 * del fichero en cada contenedor de la flota.
 */

/*
 * Los tipos de los hechos —`PermisosDelAlias`, `CuotaDelAlias`, `ArnesDelAlias`,
 * `HechosDelAlias`— viven en `@cauce/protocol` y NO acá. Los produce `@cauce/store` leyendo
 * `memberships`/`role_policies`, el camino del techo de ruteo y `agents`+`harness_definitions`, y
 * los consume este módulo: las dos capas no se pueden importar entre sí, y `@cauce/protocol` es la
 * única que las dos ven. Se reexportan para que quien compile no tenga que importar de dos sitios.
 */
export type { ArnesDelAlias, ContextoDeAlias, CuotaDelAlias, HechosDelAlias, PermisosDelAlias };

/**
 * Las claves de `openclaw.json` que la proyección no puede emitir JAMÁS.
 *
 * `openclaw.json` guarda `auth` y `secrets` en el MISMO documento que la directiva; por eso está
 * en la lista de «nunca se sirve» del pty-agent y del gateway, y por eso la siembra de openclaw es
 * proyección campo a campo y nunca escritura del fichero entero. Se exporta para que la prueba
 * pueda comprobar la ausencia contra esta lista y no contra una copia suya que se desincronice.
 */
export const CLAVES_PROHIBIDAS_OPENCLAW = [
  "auth", "secrets", "credentials", "tokens", "apiKey", "api_key",
] as const;

/** Una viñeta Markdown por elemento, en el orden en que vino. */
export function vinetas(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Una sección con su encabezado, o `undefined` si no hay cuerpo.
 *
 * Devolver `undefined` y no una cadena vacía es lo que hace que la sección desaparezca entera en
 * vez de dejar un encabezado hueco. Un encabezado sin nada debajo le enseña al agente que el
 * sistema no sabe la respuesta, que es peor que no preguntar — la misma regla por la que el
 * adaptador omite `Tu rol:` cuando el brief es NULL, y la lección del SOUL.md de fábrica de `iza`.
 */
export function seccion(titulo: string, cuerpo: string | undefined): string | undefined {
  if (cuerpo === undefined || cuerpo.trim().length === 0) return undefined;
  return `## ${titulo}\n\n${cuerpo.trim()}`;
}

/**
 * Los permisos se dicen por su EFECTO y los denegados se nombran igual que los concedidos.
 *
 * Nombrar sólo lo concedido deja al agente adivinando si lo que falta es que no lo tiene o que
 * nadie lo escribió, y un agente que no sabe si puede hacer algo lo intenta. Decir «control: no»
 * cierra esa duda y cuesta cuatro palabras.
 */
export function lineasDePermisos(permisos: PermisosDelAlias): string {
  const marca = (concedido: boolean): string => (concedido ? "sí" : "no");
  return [
    `- Rutear mensajes a otros alias: ${marca(permisos.ruta)}`,
    `- Leer el estado de la flota: ${marca(permisos.lectura)}`,
    `- Cambiar configuración (control): ${marca(permisos.control)}`,
    `- Avisar a un humano por notify: ${marca(permisos.notificacion)}`,
  ].join("\n");
}

export function lineasDeCuotas(cuotas: readonly CuotaDelAlias[]): string | undefined {
  if (cuotas.length === 0) return undefined;
  return cuotas
    .map((cuota) => {
      const limite = cuota.limite === undefined ? "" : ` — ${cuota.limite}`;
      return `- ${cuota.proveedor} / ${cuota.cuenta}${limite}`;
    })
    .join("\n");
}

export function lineasDeArnes(hechos: HechosDelAlias): string {
  const lineas = [`- Arnés: ${hechos.arnes.harness}`, `- HOME: ${hechos.arnes.home}`];
  if (hechos.arnes.contenedor !== undefined && hechos.arnes.contenedor.length > 0) {
    lineas.push(`- Contenedor: ${hechos.arnes.contenedor}`);
  }
  if (hechos.destinos.length > 0) {
    lineas.push(`- Alias alcanzables: ${[...hechos.destinos].join(", ")}`);
  }
  return lineas.join("\n");
}

/**
 * EL ORDEN DE LAS SECCIONES ES FIJO Y ESTÁ DECLARADO ACÁ.
 *
 * De arriba abajo: quién sos -> qué te toca -> qué podés -> con qué contás -> cómo está montado ->
 * cómo se funciona. Es el mismo criterio de lectura que `protocolPrompt`: el agente lee primero su
 * identidad y sólo al final la mecánica.
 *
 * Está escrito como una lista y no como concatenación suelta para que el determinismo sea
 * estructural: cambiar el orden exige cambiar esta lista, no puede pasar por accidente.
 */
export function componerBloqueDePerfil(perfil: AgentProfile, hechos: HechosDelAlias): string {
  const rol = [
    perfil.role_summary ?? undefined,
    perfil.responsibilities.length > 0
      ? `Responsabilidades:\n${vinetas(perfil.responsibilities)}`
      : undefined,
    perfil.restrictions.length > 0
      ? `Restricciones:\n${vinetas(perfil.restrictions)}`
      : undefined,
  ].filter((parte): parte is string => parte !== undefined).join("\n\n");

  const herramientas = [
    perfil.tools.length > 0 ? vinetas(perfil.tools) : undefined,
    hechos.arnes.capacidades.length > 0
      ? `Capacidades del arnés: ${[...hechos.arnes.capacidades].join(", ")}`
      : undefined,
  ].filter((parte): parte is string => parte !== undefined).join("\n\n");

  const secciones = [
    seccion("Identidad y propósito", perfil.purpose ?? undefined),
    seccion("Rol, responsabilidades y restricciones", rol),
    // Va DESPUÉS del rol y antes de los permisos: primero quién sos y qué te toca, después con
    // quién tratás, y sólo entonces la mecánica. `openclaw` lee esta cara en un fichero aparte.
    seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined),
    // Los permisos SIEMPRE se emiten si el perfil tiene alguna otra cara: un alias sin permisos
    // declarados es un hecho, no una ausencia, y saberlo le evita intentar lo que no puede.
    seccion("Permisos y acceso vía Cauce", lineasDePermisos(hechos.permisos)),
    seccion("Cuotas y límites", lineasDeCuotas(hechos.cuotas)),
    seccion("Herramientas y capacidades", herramientas),
    seccion("Configuración del arnés", lineasDeArnes(hechos)),
    seccion("Instrucciones fijas de funcionamiento",
      perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
  ].filter((parte): parte is string => parte !== undefined);

  /*
   * Un perfil ENTERAMENTE vacío produce texto vacío, no un esqueleto de encabezados. Los permisos
   * y la configuración del arnés son hechos que siempre existen, así que sin este corte un alias
   * sin nada escrito recibiría un fichero que sólo le dice en qué contenedor corre — ruido con
   * forma de contrato. `componerRolDelPerfil` devolviendo "" es la señal de «no hay perfil», y el
   * llamador omite la línea `Tu rol:` igual que hoy omite un `role_brief` NULL.
   */
  const hayAutorado =
    (perfil.purpose ?? null) !== null || (perfil.role_summary ?? null) !== null ||
    (perfil.human_brief ?? null) !== null ||
    perfil.responsibilities.length > 0 || perfil.restrictions.length > 0 ||
    perfil.tools.length > 0 || perfil.operating_rules.length > 0;
  if (!hayAutorado) return "";

  return secciones.join("\n\n");
}

/**
 * JSON determinista: las claves salen SIEMPRE en el mismo orden, lo insertaran como lo insertaran.
 *
 * `JSON.stringify` respeta el orden de inserción, así que el mismo objeto construido desde dos
 * sitios distintos —o venido de un `JSON.parse` de otra fuente— produce bytes distintos y por lo
 * tanto un sello distinto. Ordenar las claves hace que el determinismo no dependa de cómo se armó
 * el objeto, que es la única forma de que sea una garantía y no una coincidencia.
 */
export function serializarEstable(valor: unknown): string {
  return JSON.stringify(ordenar(valor), null, 2);
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor === null || typeof valor !== "object") return valor;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .sort(([izquierda], [derecha]) => (izquierda < derecha ? -1 : izquierda > derecha ? 1 : 0));
  const ordenado: Record<string, unknown> = {};
  for (const [clave, contenido] of entradas) ordenado[clave] = ordenar(contenido);
  return ordenado;
}

/**
 * La proyección de openclaw: SÓLO el subárbol `agents.<alias>`, nunca el fichero.
 *
 * `openclaw.json` guarda `auth` y `secrets` en el mismo documento que la directiva. Tratarlo como
 * un fichero de texto y reescribirlo entero es cómo se filtra o se pierde una credencial, y por eso
 * `rutaDelContextoFijo()` devuelve `undefined` para openclaw a propósito: ese arnés no tiene
 * camino de fichero, tiene camino de proyección, y es éste.
 *
 * Lo que se devuelve es un FRAGMENTO para fusionar campo a campo contra el documento vivo. Este
 * módulo no lee `openclaw.json`, no lo parsea y no lo escribe: no puede filtrar lo que nunca tuvo
 * delante. El sello viaja DENTRO del fragmento para que se pueda comprobar si el contenedor está
 * al día sin volver a leer el perfil ni el resto del documento.
 */
export function proyeccionOpenclaw(alias: string, bloque: string): string {
  return serializarEstable({
    agents: {
      [alias]: {
        instructions: bloque,
        cauce: { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(bloque) },
      },
    },
  });
}

// ── EL BLOQUE B: el perfil, fuera del bloque sellado ─────────────────────────────────────────

/**
 * DOS BLOQUES EN EL MISMO FICHERO, Y POR QUÉ NO PUEDE SER UNO.
 *
 * El sello del contexto fijo resume `textoFijoDelSobre()`, que incluye la línea
 * `Tu rol: <role_brief>` con el brief de siempre — tope 1.200 puntos de código, porque ese texto
 * viaja en el sobre de cada entrega. El perfil rico admite 24.000 unidades.
 *
 * Si el perfil entero entrara en el bloque sellado, el sha del fichero NO coincidiría nunca con el
 * que calcula el adaptador —que compone el suyo con el `role_brief` corto que viene en el sobre— y
 * el recorte no se activaría JAMÁS: se seguiría mandando el sobre entero en cada entrega, el
 * trabajo no ahorraría un solo carácter, y no aparecería ni un error. Es la clase de fallo que en
 * esta flota cuesta días adjudicar, porque no se ve: sólo se paga.
 *
 * Por eso:
 *   BLOQUE A (sellado)    — el contrato, entre `MARCA_INICIO`/`MARCA_FIN`. Es lo único que el
 *                           sello resume y lo único que el sobre deja de mandar.
 *   BLOQUE B (sin sellar) — el perfil, entre estas marcas. El arnés carga el fichero ENTERO, así
 *                           que el agente lo lee igual; y como no viaja en el sobre, es contexto
 *                           que gana SIN COSTE POR TURNO.
 *
 * El perfil sigue siendo la única fuente de verdad: el `role_brief` corto del bloque A se DERIVA
 * de él con `rolBreveDelPerfil()`, no se escribe aparte.
 *
 * Las marcas son distintas de las de A y ninguna contiene a la otra —hay una prueba que lo fija—,
 * porque las dos búsquedas son por subcadena y un solapamiento haría que escribir un bloque se
 * llevara por delante el otro.
 */
export const VERSION_PERFIL = "1";
export const MARCA_PERFIL_INICIO =
  `<!-- CAUCE:PERFIL v${VERSION_PERFIL} — generado desde la configuración, no editar dentro de este bloque -->`;
export const MARCA_PERFIL_FIN = "<!-- CAUCE:FIN-PERFIL -->";

/**
 * Escribe el bloque del perfil conservando TODO lo de fuera byte a byte — incluido el bloque A y
 * lo que haya escrito una persona.
 *
 * Reusa la fusión de `contexto-fijo.ts` en vez de copiarla: la parte sutil (buscar la última
 * apertura con cierre detrás, para no destrozar una siembra cortada a medias) ya costó una prueba
 * descubrirla, y dos copias son dos sitios donde volver a equivocarse.
 */
export function conBloqueDePerfil(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** El bloque del perfil que hay en un fichero, sin las marcas, o `undefined` si no está. */
export function bloqueDePerfil(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/**
 * El `role_brief` corto que viaja en el sobre, DERIVADO del perfil.
 *
 * Que se derive y no se escriba aparte es lo que mantiene una sola fuente de verdad: dos textos
 * escritos a mano para lo mismo se desincronizan, y ese es exactamente el problema que la tabla
 * `agent_profiles` vino a resolver.
 *
 * Se recorta con `clampToRoleBriefLimit`, que corta por PUNTOS DE CÓDIGO. `slice(0, 1200)` indexa
 * unidades UTF-16 y partiría un emoji por la mitad, dejando un surrogate suelto que al serializarse
 * viaja como U+FFFD: el agente recibiría su propio rol terminado en un carácter roto.
 *
 * `null` cuando no hay rol declarado, para que el preámbulo omita la línea `Tu rol:` en vez de
 * inventar una — un rol equivocado es peor que ninguno.
 */
export function rolBreveDelPerfil(perfil: AgentProfile): string | null {
  if (perfil.role_summary === null) return null;
  return clampToRoleBriefLimit(perfil.role_summary);
}

/**
 * El bloque B a partir de lo que devuelve `AgentProfileRepository.readContext()`, de una pieza.
 *
 * Es la superficie que usa quien genera: pide el contexto al store y lo compila, sin tener que
 * saber que los permisos salen de `role_policies` y las cuotas de detrás del techo de ruteo. Esa
 * dispersión —cinco tablas y un YAML -- es justamente lo que este trabajo vino a cerrar.
 */
export function compilarContexto(contexto: ContextoDeAlias): string {
  return componerBloqueDePerfil(contexto.perfil, contexto.hechos);
}
