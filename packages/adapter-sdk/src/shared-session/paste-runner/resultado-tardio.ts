import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";


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
    return undefined;
  }
}
