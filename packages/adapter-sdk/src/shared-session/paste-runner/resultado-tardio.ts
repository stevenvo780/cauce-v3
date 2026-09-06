import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranscriptReader, TurnOutcome } from "../types.js";

/**
 * Rescue of an envelope that arrives AFTER its delivery already died.
 *
 * POR QUÉ EXISTE. Medido el 2026-09-06 con la entrega cd484926 (astra -> kratos): murió a las
 * 23:21:12 con EXECUTION_TIMEOUT_AMBIGUOUS y el arnés terminó a las **23:26:16**, cinco minutos
 * después. Su respuesta —6.866 caracteres, con el diagnóstico y el despliegue ya hechos— no
 * quedó en NINGÚN sitio: `deliveries.result` vacío, ningún mensaje al bus, y el sobre llevaba una
 * correlación que ya no correspondía a ninguna entrega viva. Trabajo hecho y tirado.
 *
 * QUÉ HACE. Cuando se levanta la cuarentena de esa generación —que sólo ocurre porque el panel
 * dejó de generar, o sea porque el turno TERMINÓ— barre la cola de la transcripción buscando el
 * sobre de esa correlación y, si existe, lo guarda en disco. No lo reinyecta ni lo entrega: eso
 * es decisión de un operador, y la entrega ya está muerta. Guardarlo es lo que convierte
 * «trabajo perdido» en «trabajo recuperable».
 *
 * SIN DUPLICADOS: se escribe con `flag: "wx"`, así que el segundo intento sobre la misma
 * correlación falla y no se toca el fichero ya escrito. Idempotente por construcción, no por
 * comprobación previa (que tendría carrera).
 *
 * NUNCA LANZA: un fallo aquí no puede impedir que la cuarentena se levante — eso dejaría el panel
 * bloqueado, que es peor que perder el rescate. Misma regla que `sembrarPerfil`.
 */

/** Cuánta cola de la transcripción se barre. El sobre se escribe al final del turno. */
const COLA_BYTES = 2_000_000;

export interface ResultadoTardioRescatado {
  readonly ruta: string;
  readonly correlationId: string;
}

export function directorioResultadosTardios(quarantineFile: string): string {
  return join(dirname(quarantineFile), "resultados-tardios");
}

export async function rescatarResultadoTardio<E>(opciones: {
  readonly transcript: TranscriptReader<E>;
  readonly quarantineFile: string | undefined;
  readonly file: string | undefined;
  readonly correlationId: string;
  readonly tamano?: (ruta: string) => Promise<number>;
}): Promise<ResultadoTardioRescatado | undefined> {
  const { transcript, quarantineFile, file, correlationId } = opciones;
  if (quarantineFile === undefined || file === undefined) return undefined;
  if (transcript.findEnvelope === undefined) return undefined;
  try {
    const total = await (opciones.tamano?.(file) ?? Promise.resolve(0));
    const desde = Math.max(0, total - COLA_BYTES);
    const slice = await transcript.read(file, desde);
    const sobre: TurnOutcome | undefined = transcript.findEnvelope(slice.entries, correlationId);
    if (sobre === undefined || sobre.kind === "failed") return undefined;
    const carpeta = directorioResultadosTardios(quarantineFile);
    await mkdir(carpeta, { recursive: true });
    const ruta = join(carpeta, `${correlationId}.json`);
    await writeFile(ruta, `${JSON.stringify({
      correlation_id: correlationId,
      rescatado_en: new Date().toISOString(),
      transcripcion: file,
      texto: sobre.text,
      ...(sobre.sessionId === undefined ? {} : { session_id: sobre.sessionId }),
    }, null, 1)}\n`, { flag: "wx", encoding: "utf8" });
    return { ruta, correlationId };
  } catch {
    // Ya existía (rescate previo) o el disco falló. En los dos casos: no romper el saneo.
    return undefined;
  }
}
