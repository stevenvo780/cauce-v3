import { FICHEROS_OPENCLAW, governanceSensitiveBasenameKind } from '@cauce/protocol';
import {
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
 * The ONLY gate that may consult the write path. Fails closed.
 *
 * `resolved` is what the agent sees after following links (`realpath`). It is required because a
 * `CLAUDE.md` that is a symlink to `~/.claude/.credentials.json` would pass any check done on the
 * requested name alone.
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
    const sensitiveKind = governanceSensitiveBasenameKind(base);
    if (sensitiveKind === 'forbidden_basename') {
      return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
    }
    if (sensitiveKind === 'credential_suffix') {
      return { allowed: false, reason: `\`${base}\` parece material de credencial` };
    }
  }

  // After following links, the path must remain the same. A different `realpath` means symlink,
  // and a symlink is exactly the vector the blacklist does not see.
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta es un enlace; se escribe el fichero, no el enlace' };
  }
  return { allowed: true };
}

/** Separate gate for the profile batch. It does not unlock settings/openclaw.json or UI paths. */
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
    if (governanceSensitiveBasenameKind(base) !== undefined) {
      return { allowed: false, reason: 'el destino parece material sensible' };
    }
  }
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta del perfil es un enlace' };
  }
  return { allowed: true };
}

/**
 * Maximum size allowed for reading and writing governance documents (256 KB).
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * Names this route DOES serve. It is a whitelist, not a blacklist: the Directive modal shows the
 * site manual and nothing else. `settings.json` and `config.toml` appear in the inventory from
 * `resolveAgentDocuments` because they must be viewable and editable, but they do NOT travel on
 * the pty-agent READ channel — and the pty-agent itself rejects them even if the gateway asks.
 */
export const READ_ALLOWED_BASENAMES: readonly string[] = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md',
];
const PROFILE_READ_BASENAMES: readonly string[] = [...FICHEROS_OPENCLAW, ...READ_ALLOWED_BASENAMES];

/**
 * The ONLY gate on the READ path, sibling of `verifyWritablePath`. Fails closed.
 *
 * It deliberately repeats checks that the pty-agent performs on its own
 * (`_validate_read_path`). This is not careless duplication: they are two independent defenses,
 * and a single failure on either one must not be enough to serve a credential. What the gateway
 * CANNOT do from here is follow links — the file lives in another machine, inside another
 * container — so `realpath` is checked by the agent and only by the agent.
 */
export function verifyReadablePath(facts: RuntimeFacts, requested: string): PathVerdict {
  if (!requested.startsWith('/')) return { allowed: false, reason: 'la ruta tiene que ser absoluta' };
  if (requested.includes('\0')) return { allowed: false, reason: 'la ruta lleva un byte nulo' };
  if (requested.length > 4096) return { allowed: false, reason: 'la ruta es demasiado larga' };

  // Canonical form is required, not normalization. Normalization is exactly where the gap between
  // what the gateway validates and what the agent opens appears.
  const segments = requested.split('/');
  if (segments.includes('..') || segments.includes('.') || segments.slice(1).includes('')) {
    return { allowed: false, reason: 'la ruta no está en forma canónica' };
  }

  const base = segments[segments.length - 1] ?? '';
  const sensitiveKind = governanceSensitiveBasenameKind(base);
  if (sensitiveKind === 'forbidden_basename') {
    return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
  }
  if (sensitiveKind === 'credential_suffix') {
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

  // The CLOSED set rules: the path must be one of those derived from measured facts. The browser
  // sends an alias, never a path, and this reasserts that here.
  if (!resolveAgentDocuments(facts).some((doc) => doc.path === requested)
      && !profilePath && !effectiveManual) {
    return { allowed: false, reason: 'la ruta no es la de ningún documento de ese alias' };
  }
  return { allowed: true };
}

/**
 * Decides whether an inventory row has content that can be served via the `:kind/content` route.
 *
 * `editable` is not enough for this decision: project manuals and the files making up the OpenClaw
 * profile can be inspected, but their writes go through other rules (or the canonical Profile
 * batch). Conversely, the mere existence of a row in the inventory does not make it readable:
 * `settings.json`, `config.toml`, directories and configs with secrets are listed to explain
 * where they live, but they are never opened from the browser.
 *
 * The category only narrows the intent. The final authority is still `verifyReadablePath`, which
 * demands an absolute, canonical path inside the closed set derived from measured facts.
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
