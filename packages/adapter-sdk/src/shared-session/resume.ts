import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { rolloutDirectory } from "./rollout.js";
import { transcriptDirectoryIn } from "./session.js";
import type { ResumeSpec, SharedSessionHarness } from "./types.js";

/**
 * Si el panel del dueño se rehace, que vuelva con su conversación.
 *
 * Las dos TUI saben reanudar y ninguna lo hace sola: invocadas a secas abren una conversación en
 * blanco aunque su registro siga entero en disco. Lo que falta es decirles que reanuden y —sobre
 * todo— saber ANTES si hay algo que reanudar, porque pedirlo en vacío puede matar el panel.
 *
 * Medido el 2026-08-06 en `ws-zeus`, con tmux y directorios de trabajo desechables, dejando un
 * marcador en una conversación, matando la sesión y volviéndola a crear:
 *
 *  - codex 0.145.0, `codex resume --last`: el marcador VUELVE. El panel muestra el turno anterior y
 *    el modelo contesta la palabra clave sin leer ningún fichero. Sin nada que reanudar no muere:
 *    abre una conversación nueva (0.144.x sí fallaba, y por eso la comprobación previa se queda).
 *  - claude 2.1.223, `claude --continue`: el marcador VUELVE, igual. Pero sin conversación previa
 *    escribe «No conversation found to continue» y sale con código 1 — el panel muere al nacer y
 *    tmux se lleva la sesión con él. Esa es la rama que obliga a preguntar primero.
 */

/**
 * Cuántos registros se miran, como mucho, buscando uno reanudable.
 *
 * No es una optimización de lujo: `ws-prizma` tenía 6.511 rollouts, y la cabecera de uno solo puede
 * pesar decenas de KB porque lleva dentro las instrucciones del sistema. Leerlos todos cada vez que
 * arranca un panel costaría más que el propio arranque, y se pagaría entero justo en el caso malo
 * (cuando NO hay nada que reanudar).
 *
 * El orden es por nombre descendente, que en codex es cronológico: el fichero se llama
 * `rollout-<fecha ISO>-<uuid>.jsonl` y cuelga de `sessions/AAAA/MM/DD/`. Recortar por ahí sólo
 * puede hacernos decir "no hay" cuando la única conversación de este directorio es antiquísima, y
 * ese error cae del lado bueno: se arranca en blanco, que es lo que pasaba siempre hasta hoy.
 */
const MAX_ROLLOUTS_INSPECTED = 200;

/**
 * Cuánto se lee buscando el final de la primera línea de un rollout.
 *
 * Los rollouts vivos llegan a decenas de MB —el mayor medido pesaba 69— así que leerlos enteros no
 * es una opción. La cabecera `session_meta` es la primera línea y trae dentro `base_instructions`,
 * que son varios KB; un cuarto de mega da margen de sobra sin dejar de ser una lectura acotada.
 */
const HEADER_READ_LIMIT_BYTES = 256 * 1024;

export function sharedSessionResume(
  harness: SharedSessionHarness,
  configDirectory: string,
  workspace: string,
): ResumeSpec {
  return harness === "codex"
    ? {
      // `--last` reanuda sin abrir el selector interactivo, y filtra por el directorio de trabajo
      // actual: es el mismo filtro que se aplica acá abajo. (`--all` existe justamente para
      // DESACTIVAR ese filtro, según su propia ayuda.)
      args: ["resume", "--last"],
      hasPreviousConversation: () => codexHasPreviousConversation(configDirectory, workspace),
    }
    : {
      args: ["--continue"],
      hasPreviousConversation: () => claudeHasPreviousConversation(configDirectory, workspace),
    };
}

/**
 * ¿Tiene codex una conversación que `resume --last` pueda reabrir en ESTE directorio?
 *
 * Se aplica el mismo filtro que codex: sólo cuentan las sesiones interactivas (`"source":"cli"`; las
 * de subagente llevan `"source":{"subagent":…}` y quedan fuera mientras no se pase
 * `--include-non-interactive`) y sólo las de este `cwd`. Los dos campos viven en la primera línea
 * del rollout, el `session_meta`; comprobado sobre el rollout real escrito por la TUI el
 * 2026-08-06: `{"type":"session_meta","payload":{…,"cwd":"…/ws-codex","source":"cli",…}}`.
 */
export async function codexHasPreviousConversation(
  codexHome: string,
  workspace: string,
): Promise<boolean> {
  const files = await rolloutsByRecency(rolloutDirectory(codexHome));
  for (const file of files.slice(0, MAX_ROLLOUTS_INSPECTED)) {
    const meta = await rolloutHeader(file);
    if (meta === undefined) continue;
    if (meta.source !== "cli") continue;
    if (meta.cwd !== workspace) continue;
    return true;
  }
  return false;
}

/**
 * ¿Tiene claude una conversación que `--continue` pueda reabrir en ESTE directorio?
 *
 * `--continue` reanuda la última conversación DEL DIRECTORIO ACTUAL, y el directorio donde claude
 * las guarda es exactamente el que calcula `transcriptDirectoryIn` — el mismo del que el adaptador
 * cosecha las respuestas. Derivar los dos del mismo valor es lo que impide que la pregunta y la
 * respuesta miren a sitios distintos.
 *
 * Un `.jsonl` de tamaño cero no cuenta: es un fichero recién creado, no una conversación.
 */
export async function claudeHasPreviousConversation(
  configDirectory: string,
  workspace: string,
): Promise<boolean> {
  const directory = transcriptDirectoryIn(configDirectory, workspace);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const info = await stat(join(directory, name));
      if (info.isFile() && info.size > 0) return true;
    } catch {
      // Un fichero que desaparece entre el listado y el `stat` no es una conversación reanudable.
    }
  }
  return false;
}

/** Los rollouts del árbol, de más nuevo a más viejo por su nombre (que es cronológico). */
async function rolloutsByRecency(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** El `session_meta` del rollout: sólo la primera línea, y con un tope de lectura. */
async function rolloutHeader(
  file: string,
): Promise<{ source?: unknown; cwd?: unknown } | undefined> {
  let line: string | undefined;
  try {
    const stream = createReadStream(file, {
      start: 0, end: HEADER_READ_LIMIT_BYTES - 1, encoding: "utf8",
    });
    let raw = "";
    for await (const chunk of stream) {
      raw += String(chunk);
      const cut = raw.indexOf("\n");
      if (cut >= 0) {
        stream.destroy();
        line = raw.slice(0, cut);
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const payload = (value as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return payload;
}
