import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { clone } from "./atomic-state.js";
import {
  EMPTY_SESSIONS,
  MAX_SESSIONS_FILE_BYTES,
  type CanonicalOpenCodeSessionPointer,
  type SessionOrigin,
  type SessionRecord,
  type SessionsFile,
} from "./contracts.js";

const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

export class InvalidSessionsFileError extends Error {
  readonly code = "INVALID_SESSIONS_FILE";

  constructor() {
    super("sessions.json failed secure validation");
    this.name = "InvalidSessionsFileError";
  }
}

function invalidSessionsFile(): never {
  throw new InvalidSessionsFileError();
}

function rejectDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    if (text[offset] !== '"') invalidSessionsFile();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          invalidSessionsFile();
        }
      }
      offset += 1;
    }
    invalidSessionsFile();
  };
  const value = (): void => {
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = string();
        if (keys.has(key)) invalidSessionsFile();
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") invalidSessionsFile();
        offset += 1;
        value();
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") invalidSessionsFile();
        offset += 1;
        whitespace();
      }
      invalidSessionsFile();
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        value();
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") invalidSessionsFile();
        offset += 1;
      }
      invalidSessionsFile();
    }
    if (text[offset] === '"') {
      string();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/u.test(text[offset]!)) offset += 1;
    if (offset === start) invalidSessionsFile();
  };
  value();
  whitespace();
  if (offset !== text.length) invalidSessionsFile();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/**
 * Juego de caracteres y cotas de los tres campos de `SessionOrigin`.
 *
 * El tope importa por una razón concreta y no por prolijidad: `validateSessionsFile` admite
 * hasta 4096 entradas y `readSessionsSecure` rechaza el fichero entero pasado 1 MiB. Un origen
 * sin cota multiplicado por 4096 entradas empuja contra ese techo, y pasarse NO degrada: deja
 * al alias sin ninguna sesión con INVALID_SESSIONS_FILE.
 */
const SESSION_ORIGIN_FIELD = /^[A-Za-z0-9._:@+-]{1,128}$/u;

/**
 * Un origen con forma inesperada se DESCARTA; no invalida el fichero.
 *
 * Es deliberadamente asimétrico con el resto del validador, que es estricto y tira. La razón es
 * la consecuencia: `native_id` es lo único de lo que depende reanudar una conversación, así que
 * ahí una forma rara es corrupción y hay que parar. `origin` es una etiqueta para el humano;
 * perderla degrada a "sin origen" —que es la respuesta honesta que el lector ya sabe dar— y
 * tirar por ella convertiría un metadato cosmético en una caída del alias.
 */
export function sanitizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["adapter", "channel", "conversation_id"])) return undefined;
  const { adapter, channel, conversation_id: conversationId } = record;
  if (typeof adapter !== "string" || !SESSION_ORIGIN_FIELD.test(adapter)) return undefined;
  if (typeof channel !== "string" || !SESSION_ORIGIN_FIELD.test(channel)) return undefined;
  if (typeof conversationId !== "string"
    || !SESSION_ORIGIN_FIELD.test(conversationId)) return undefined;
  return { adapter, channel, conversation_id: conversationId };
}

export function validateSessionsFile(value: unknown): SessionsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidSessionsFile();
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["version", "sessions"]) || root.version !== 1
    || typeof root.sessions !== "object" || root.sessions === null || Array.isArray(root.sessions)) {
    invalidSessionsFile();
  }
  const entries = Object.entries(root.sessions as Record<string, unknown>);
  if (entries.length > 4096) invalidSessionsFile();
  const sessions = Object.create(null) as Record<string, SessionRecord>;
  for (const [key, valueRecord] of entries) {
    if (!/^(?:hermes|opencode|claude|codex|openclaw|fake):[A-Za-z0-9._:-]{1,500}$/u.test(key)
      || typeof valueRecord !== "object"
      || valueRecord === null
      || Array.isArray(valueRecord)) invalidSessionsFile();
    const record = valueRecord as Record<string, unknown>;
    // Las DOS formas admitidas, y sólo esas: la vieja (sin `origin`) sigue siendo válida tal
    // cual, así que ninguna entrada escrita antes de este cambio se rompe.
    if (!(exactKeys(record, ["native_id", "initialized"])
        || exactKeys(record, ["native_id", "initialized", "origin"]))
      || typeof record.native_id !== "string"
      || !/^[A-Za-z0-9._:-]{1,512}$/u.test(record.native_id)
      || typeof record.initialized !== "boolean") invalidSessionsFile();
    const origin = sanitizeSessionOrigin(record.origin);
    sessions[key] = {
      native_id: record.native_id,
      initialized: record.initialized,
      ...(origin === undefined ? {} : { origin }),
    };
  }
  return { version: 1, sessions };
}

export async function readSessionsSecure(path: string): Promise<SessionsFile> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY
        | O_CLOEXEC
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY_SESSIONS);
    throw new InvalidSessionsFileError();
  }
  try {
    const before = await handle.stat();
    const euid = process.geteuid?.();
    if (euid === undefined
      || !before.isFile()
      || before.uid !== euid
      || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1
      || before.size <= 0
      || before.size > MAX_SESSIONS_FILE_BYTES) invalidSessionsFile();

    const buffer = Buffer.alloc(MAX_SESSIONS_FILE_BYTES + 1);
    let length = 0;
    while (length <= MAX_SESSIONS_FILE_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        MAX_SESSIONS_FILE_BYTES + 1 - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_SESSIONS_FILE_BYTES
      || length !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) invalidSessionsFile();

    const text = buffer.subarray(0, length).toString("utf8");
    rejectDuplicateJsonKeys(text);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      invalidSessionsFile();
    }
    return validateSessionsFile(decoded);
  } catch (error) {
    if (error instanceof InvalidSessionsFileError) throw error;
    throw new InvalidSessionsFileError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function isCanonicalOpenCodeScopeKey(value: string): boolean {
  return /^auth-v1:[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isCanonicalOpenCodeSessionId(value: string): boolean {
  return /^ses_[A-Za-z0-9_-]{4,124}$/u.test(value);
}

export function canonicalOpenClawTerminalKey(alias: string): string | undefined {
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(alias)
    ? `openclaw:${alias}:shared:${alias}`
    : undefined;
}

export function unavailableCanonicalOpenCodeSession(
  reason: "missing" | "ambiguous" | "invalid",
): CanonicalOpenCodeSessionPointer {
  return {
    version: 1,
    state: "unavailable",
    alias: "kant",
    harness: "opencode",
    scope_key: null,
    session_id: null,
    reason,
  };
}

export function activeCanonicalOpenCodeSession(scopeKey: string, sessionId: string): CanonicalOpenCodeSessionPointer {
  return {
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: scopeKey,
    session_id: sessionId,
  };
}
