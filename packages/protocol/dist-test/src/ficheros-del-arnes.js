import { componerBloqueDePerfil, lineasDeArnes, lineasDeCuotas, lineasDePermisos, measureStrictestUnits, seccion, vinetas, } from "./agent-profile.js";
import { conBloqueDePerfil } from "./marcas-de-bloque.js";
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
 * Mismo perfil y mismos hechos -> los mismos bytes, siempre. Sin fechas, sin relojes y sin recorrer
 * claves en orden incidental: el reparto es una lista FIJA declarada en el código. No es
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
export const TOPES_OPENCLAW = { porFichero: 60_000, total: 150_000 };
/** Los siete ficheros de openclaw, en el orden en que se emiten. Es el orden medido en la flota. */
export const FICHEROS_OPENCLAW = [
    "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md",
];
/**
 * Un tope superado, con el fichero y los DOS números.
 *
 * Falla en vez de truncar, y ésa es la decisión del módulo. Truncar en silencio deja una persona a
 * medias —un `SOUL.md` entero y un `IDENTITY.md` cortado en mitad de una frase—, que es peor que no
 * escribir nada: el agente lee lo truncado como si fuera todo lo que hay. Y lleva el nombre del
 * fichero y los dos números porque «no entra» sobre siete ficheros no le dice a nadie qué recortar.
 */
export class ErrorDeTopeDelArnes extends Error {
    fichero;
    medido;
    tope;
    constructor(fichero, medido, tope) {
        super(fichero === "total"
            ? `los ficheros del arnés suman ${medido} unidades y el tope total es ${tope}`
            : `${fichero} mide ${medido} unidades y el tope por fichero es ${tope}`);
        this.fichero = fichero;
        this.medido = medido;
        this.tope = tope;
        this.name = "ErrorDeTopeDelArnes";
    }
}
/** Los nombres que le tocan a un arnés, sin generar nada. Un arnés desconocido no recibe ninguno. */
export function nombresDelArnes(harness) {
    if (harness === "claude")
        return ["CLAUDE.md"];
    if (harness === "codex")
        return ["AGENTS.md"];
    if (harness === "openclaw")
        return [...FICHEROS_OPENCLAW];
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
 * `permisos`, `destinos` y la configuración del arnés caen en `AGENTS.md` porque son el «cómo se
 * trabaja acá»: qué te deja hacer Cauce y contra qué estás montado. Las `cuotas` caen en
 * `TOOLS.md` porque son el límite de las herramientas, no una regla de convivencia.
 */
function bloqueDeFichero(nombre, perfil, hechos) {
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
        return unir([
            seccion("Responsabilidades", perfil.responsibilities.length > 0 ? vinetas(perfil.responsibilities) : undefined),
            seccion("Restricciones", perfil.restrictions.length > 0 ? vinetas(perfil.restrictions) : undefined),
            seccion("Instrucciones fijas de funcionamiento", perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
            seccion("Permisos y acceso vía Cauce", lineasDePermisos(hechos.permisos)),
            seccion("Configuración del arnés", lineasDeArnes(hechos)),
        ]);
    }
    if (nombre === "TOOLS.md") {
        return unir([
            seccion("Herramientas y capacidades", unir([
                perfil.tools.length > 0 ? vinetas(perfil.tools) : undefined,
                hechos.arnes.capacidades.length > 0
                    ? `Capacidades del arnés: ${[...hechos.arnes.capacidades].join(", ")}`
                    : undefined,
            ])),
            seccion("Cuotas y límites", lineasDeCuotas(hechos.cuotas)),
        ]);
    }
    // MEMORY.md y HEARTBEAT.md no reciben nada nuestro: son del agente.
    return "";
}
function unir(partes) {
    return partes.filter((parte) => parte !== undefined && parte.trim().length > 0)
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
export function ficherosDelArnes(harness, contexto, existentes = new Map()) {
    const nombres = nombresDelArnes(harness);
    const generados = [];
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
        const bloque = harness === "openclaw"
            ? bloqueDeFichero(nombre, contexto.perfil, contexto.hechos)
            : componerBloqueDePerfil(contexto.perfil, contexto.hechos);
        /*
         * Sin bloque no se toca el fichero. Un encabezado sin nada debajo le enseña al agente que el
         * sistema no sabe la respuesta, que es peor que no preguntar: es la lección de los cinco
         * SOUL.md de fábrica de 1.806 bytes que llevan cinco alias sin que nadie los escribiera.
         */
        if (bloque.trim().length === 0) {
            generados.push({
                nombre, politica: "bloque-gestionado", texto: previo ?? "", escribir: false,
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
/** `MEMORY.md` y `HEARTBEAT.md` de openclaw, y nada más. */
function esDelAgente(harness, nombre) {
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
function comprobarTopes(harness, ficheros) {
    if (harness !== "openclaw")
        return;
    let total = 0;
    for (const fichero of ficheros) {
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
//# sourceMappingURL=ficheros-del-arnes.js.map