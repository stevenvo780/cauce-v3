import { FICHEROS_OPENCLAW } from '@cauce/protocol';
import {
  NEVER_SERVE_BASENAMES,
  NEVER_SERVE_SUFFIXES,
  codexFallbackFilenames,
  documentForKind,
  effectiveManualPaths,
  profileDocumentPaths,
  resolveAgentDocuments,
  type AgentDocument,
  type DocumentKind,
  type RuntimeFacts
} from './catalog.js';

export interface PathVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}
/**
 * ÚNICA puerta que puede consultar el camino de escritura. Falla cerrada.
 *
 * `resolved` es lo que el agente ve tras seguir los enlaces (`realpath`). Se exige porque un
 * `CLAUDE.md` que sea un symlink a `~/.claude/.credentials.json` pasaría cualquier comprobación
 * hecha sólo sobre el nombre pedido.
 */
export function verifyWritablePath(
  facts: RuntimeFacts,
  kind: DocumentKind,
  requested: string,
  resolved: string = requested,
): PathVerdict {
  const doc = documentForKind(facts, kind);
  if (!doc) return { allowed: false, reason: 'ese alias no tiene ese documento' };
  if (!doc.editable) return { allowed: false, reason: doc.reason ?? 'documento de sólo lectura' };
  if (doc.path !== requested) return { allowed: false, reason: 'la ruta no es la del documento resuelto' };

  for (const candidate of [requested, resolved]) {
    if (!candidate.startsWith('/')) return { allowed: false, reason: 'la ruta tiene que ser absoluta' };
    if (candidate.split('/').includes('..')) return { allowed: false, reason: 'la ruta no puede subir de directorio' };
    if (candidate.includes('\0')) return { allowed: false, reason: 'la ruta lleva un byte nulo' };

    const base = candidate.slice(candidate.lastIndexOf('/') + 1);
    if (NEVER_SERVE_BASENAMES.includes(base)) {
      return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
    }
    if (NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      return { allowed: false, reason: `\`${base}\` parece material de credencial` };
    }
  }

  // Tras seguir los enlaces la ruta tiene que seguir siendo la misma. Un `realpath` distinto
  // significa symlink, y un symlink es exactamente el vector que la lista negra no ve.
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta es un enlace; se escribe el fichero, no el enlace' };
  }
  return { allowed: true };
}

/** Puerta separada para el lote de perfil. No habilita settings/openclaw.json ni rutas del UI. */
export function verifyWritableProfilePath(
  facts: RuntimeFacts,
  requested: string,
  resolved: string = requested,
): PathVerdict {
  if (!profileDocumentPaths(facts).includes(requested)) {
    return { allowed: false, reason: 'la ruta no pertenece al juego cerrado del perfil' };
  }
  for (const candidate of [requested, resolved]) {
    if (!candidate.startsWith('/') || candidate.includes('\0') || candidate.length > 4096) {
      return { allowed: false, reason: 'la ruta del perfil no es absoluta o canónica' };
    }
    const segments = candidate.split('/');
    if (segments.includes('..') || segments.includes('.') || segments.slice(1).includes('')) {
      return { allowed: false, reason: 'la ruta del perfil no está en forma canónica' };
    }
    const base = segments[segments.length - 1] ?? '';
    if (NEVER_SERVE_BASENAMES.includes(base)
      || NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      return { allowed: false, reason: 'el destino parece material sensible' };
    }
  }
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta del perfil es un enlace' };
  }
  return { allowed: true };
}

/**
 * Límite máximo de tamaño permitido para lectura y escritura de documentos de gobierno (256 KB).
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * Nombres que esta vía SÍ sirve. Es una lista blanca, no una negra: el modal de Directiva enseña
 * el manual del sitio y nada más. `settings.json` y `config.toml` salen en el inventario de
 * `resolveAgentDocuments` porque hay que poder verlos y editarlos, pero por el canal de LECTURA
 * del pty-agent no viajan — y el propio pty-agent los rechaza aunque el gateway los pida.
 */
export const READ_ALLOWED_BASENAMES: readonly string[] = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md',
];
const PROFILE_READ_BASENAMES: readonly string[] = [...FICHEROS_OPENCLAW, ...READ_ALLOWED_BASENAMES];

/**
 * ÚNICA puerta del camino de LECTURA, hermana de `verifyWritablePath`. Falla cerrada.
 *
 * Repite a propósito comprobaciones que el pty-agent vuelve a hacer por su cuenta
 * (`_validate_read_path`). No es duplicación por descuido: son dos defensas independientes, y un
 * fallo en una sola no debe bastar para servir una credencial. Lo que el gateway NO puede hacer
 * desde aquí es seguir enlaces —el fichero vive en otra máquina, dentro de otro contenedor—, así
 * que el `realpath` lo comprueba el agente y sólo el agente.
 */
export function verifyReadablePath(facts: RuntimeFacts, requested: string): PathVerdict {
  if (!requested.startsWith('/')) return { allowed: false, reason: 'la ruta tiene que ser absoluta' };
  if (requested.includes('\0')) return { allowed: false, reason: 'la ruta lleva un byte nulo' };
  if (requested.length > 4096) return { allowed: false, reason: 'la ruta es demasiado larga' };

  // Se exige forma canónica en vez de normalizar. Normalizar es justo donde aparecen las
  // diferencias entre lo que valida el gateway y lo que abre el agente.
  const segments = requested.split('/');
  if (segments.includes('..') || segments.includes('.') || segments.slice(1).includes('')) {
    return { allowed: false, reason: 'la ruta no está en forma canónica' };
  }

  const base = segments[segments.length - 1] ?? '';
  if (NEVER_SERVE_BASENAMES.includes(base)) {
    return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
  }
  if (NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return { allowed: false, reason: `\`${base}\` parece material de credencial` };
  }
  const profilePath = profileDocumentPaths(facts).includes(requested);
  const effectiveManual = effectiveManualPaths(facts).some((manual) => manual.path === requested);
  const configuredCodexFallback = facts.harness === 'codex'
    && codexFallbackFilenames(facts).includes(base) && effectiveManual;
  if (!READ_ALLOWED_BASENAMES.includes(base)
      && !(profilePath && PROFILE_READ_BASENAMES.includes(base)) && !configuredCodexFallback) {
    return {
      allowed: false,
      reason: `\`${base}\` no es un manual efectivo permitido para ese arnés`,
    };
  }

  // El juego CERRADO manda: la ruta tiene que ser una de las que se derivan de hechos medidos.
  // El navegador manda un alias, nunca una ruta, y esto lo vuelve a exigir aquí abajo.
  if (!resolveAgentDocuments(facts).some((doc) => doc.path === requested)
      && !profilePath && !effectiveManual) {
    return { allowed: false, reason: 'la ruta no es la de ningún documento de ese alias' };
  }
  return { allowed: true };
}

/**
 * Decide si una fila del inventario tiene contenido servible por la ruta `:kind/content`.
 *
 * `editable` no sirve para tomar esta decisión: los manuales de proyecto y los ficheros que
 * componen el perfil OpenClaw se pueden inspeccionar, pero sus escrituras pasan por otras reglas
 * (o por el lote canónico de Perfil). A la inversa, que una fila exista en el inventario tampoco
 * la vuelve legible: `settings.json`, `config.toml`, directorios y configuraciones con secretos se
 * enumeran para explicar dónde viven, pero nunca se abren desde el navegador.
 *
 * La categoría sólo acota la intención. La autoridad final sigue siendo `verifyReadablePath`,
 * que exige una ruta absoluta y canónica dentro del juego cerrado derivado de hechos medidos.
 */
export function verifyReadableDocument(facts: RuntimeFacts, document: AgentDocument): PathVerdict {
  const profilePath = profileDocumentPaths(facts).includes(document.path);
  if (document.category !== 'manual' && !profilePath) {
    return {
      allowed: false,
      reason: document.reason ?? 'este elemento se inventaría, pero su contenido no se sirve por esta vía',
    };
  }
  return verifyReadablePath(facts, document.path);
}
