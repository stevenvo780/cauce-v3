import { dirname, join } from "node:path";
import { atomicWrite, prepareStateDirectory } from "../../sdk/durable-store/atomic-state.js";
import { readOwnerOnlyFile, SecureFileError } from "../../sdk/secure-files.js";

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
  if (quarantineFile === undefined || !/^[a-f0-9]{64}$/u.test(correlationId)
    || texto.trim() === "") return undefined;
  try {
    const carpeta = directorioResultadosTardios(quarantineFile);
    await prepareStateDirectory(carpeta);
    const ruta = join(carpeta, `${correlationId}.json`);
    let saved = {
      correlation_id: correlationId,
      rescatado_en: new Date().toISOString(),
      texto,
    };
    try {
      const existing: unknown = JSON.parse((await readOwnerOnlyFile(ruta, "Late shared-session result")).toString("utf8"));
      if (existing === null || typeof existing !== "object" || !("correlation_id" in existing)
        || existing.correlation_id !== correlationId || !("texto" in existing) || existing.texto !== texto
        || !("rescatado_en" in existing) || typeof existing.rescatado_en !== "string") return undefined;
      saved = { correlation_id: correlationId, rescatado_en: existing.rescatado_en, texto };
    } catch (error) {
      const cause = error instanceof SecureFileError ? error.cause : error;
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") return undefined;
    }
    await atomicWrite(ruta, saved);
    return { ruta, correlationId };
  } catch {
    return undefined;
  }
}
