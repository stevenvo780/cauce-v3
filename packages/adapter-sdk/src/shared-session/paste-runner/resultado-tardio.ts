import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Rescue of an envelope that arrives AFTER its delivery already died.
 *
 * POR QUÉ EXISTE. Medido el 2026-09-06 con la entrega cd484926 (astra -> kratos): murió a las
 * 23:21:12 con EXECUTION_TIMEOUT_AMBIGUOUS y el arnés terminó a las **23:26:16**, cinco minutos
 * después. Su respuesta —6.866 caracteres, con el diagnóstico y el despliegue ya hechos— no
 * quedó en NINGÚN sitio: `deliveries.result` vacío, ningún mensaje al bus, y el sobre llevaba una
 * correlación que ya no correspondía a ninguna entrega viva. Trabajo hecho y tirado.
 *
 * DÓNDE SE ENGANCHA, y por qué ahí. En `reconcileTerminalPending`, que es el ÚNICO punto por el
 * que pasa este caso: descarga las cuarentenas cuyo turno —ya muerto— dejó después un sobre
 * válido, y para comprobarlo ya lo encuentra y lo valida. Antes lo tiraba.
 *
 * Dos intentos fallidos antes de dar con esto, y los dos los cazó astra revisando `5a526fed`:
 * leer `pending.file` (que es el MARCADOR `<quarantineFile>.<correlación>.pending`, y encima lo
 * borra el saneo) y engancharlo en `healCurrentQuarantine` (que en este flujo NI SIQUIERA SE
 * INVOCA, porque `reconcileTerminalPending` corre antes y descarga el pending). Por eso esta vez
 * la prueba recorre el circuito real con dos ficheros distintos, no un lector simulado.
 *
 * QUÉ HACE: guardar en disco el texto del sobre. No lo reinyecta ni lo entrega — eso es decisión
 * de un operador y la entrega ya está muerta. Guardarlo es lo que convierte «trabajo perdido» en
 * «trabajo recuperable».
 *
 * SIN DUPLICADOS: se escribe con `flag: "wx"`, así que el segundo intento sobre la misma
 * correlación falla y no se toca el fichero ya escrito. Idempotente por construcción, no por
 * comprobación previa (que tendría carrera).
 *
 * NUNCA LANZA: un fallo aquí no puede impedir que la cuarentena se levante — eso dejaría el panel
 * bloqueado, que es peor que perder el rescate. Misma regla que `sembrarPerfil`.
 */

export interface ResultadoTardioRescatado {
  readonly ruta: string;
  readonly correlationId: string;
}

export function directorioResultadosTardios(quarantineFile: string): string {
  return join(dirname(quarantineFile), "resultados-tardios");
}

export async function rescatarResultadoTardio(opciones: {
  readonly quarantineFile: string | undefined;
  readonly correlationId: string;
  /** Texto del sobre, ya encontrado y validado por quien llama. */
  readonly texto: string;
}): Promise<ResultadoTardioRescatado | undefined> {
  const { quarantineFile, correlationId, texto } = opciones;
  if (quarantineFile === undefined || texto.trim() === "") return undefined;
  try {
    const carpeta = directorioResultadosTardios(quarantineFile);
    await mkdir(carpeta, { recursive: true });
    const ruta = join(carpeta, `${correlationId}.json`);
    await writeFile(ruta, `${JSON.stringify({
      correlation_id: correlationId,
      rescatado_en: new Date().toISOString(),
      texto,
    }, null, 1)}\n`, { flag: "wx", encoding: "utf8" });
    return { ruta, correlationId };
  } catch {
    // Ya existía (rescate previo) o el disco falló. En los dos casos: no romper la reconciliación.
    return undefined;
  }
}
