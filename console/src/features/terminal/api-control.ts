/**
 * The three writes of the writable TUI: taking the keyboard, giving it back, and pushing the
 * session window forward. They are fenced with the SAME browser ownership the tab already holds
 * for its session (`request_id`, `owner_generation`, `owner_token`), so a stale tab cannot mute
 * an alias behind the back of the tab that is actually driving it.
 */
import type { CauceApi } from '../../api/client';
import { TerminalApiError, terminalRequest, type TerminalSessionOwner } from './api';

type SesionConToken = Pick<CauceApi, 'csrfForMutation'>;

/** The body `parseControlRequest` accepts. `reason` is the fifth key and only a take carries it. */
export const CAMPOS_DE_CONTROL = ['action', 'owner_generation', 'owner_token', 'request_id'] as const;

/** The owner-fenced body of `/extend`, identical to the one that releases a session. */
export const CAMPOS_DE_PRORROGA = ['owner_generation', 'owner_token', 'request_id'] as const;

/** Receipt of a taken hold. While it lives, the bus keeps the alias's deliveries pending. */
export interface ControlDeTuiTomado {
  session_id: string;
  hold_id: string;
  held_by: string;
  expires_at: string;
}

export interface ControlDeTuiDevuelto {
  session_id: string;
  /** `null` when there was nothing left to give back, which is a success, not a failure. */
  hold_id: string | null;
}

export interface SesionProrrogada {
  session_id: string;
  request_id: string;
  expires_at: string;
}

function rutaDeSesion(sessionId: string, sufijo: string): string {
  return `/v3/console/terminal/sessions/${encodeURIComponent(sessionId)}/${sufijo}`;
}

function cuerpoConDueno(owner: TerminalSessionOwner): Record<string, string> {
  return {
    request_id: owner.request_id,
    owner_generation: owner.owner_generation,
    owner_token: owner.owner_token,
  };
}

function recibo(value: unknown, mensaje: string, codigo: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TerminalApiError(mensaje, 409, codigo);
  }
  return value as Record<string, unknown>;
}

function texto(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Takes the keyboard: `reason` is what the operator typed, never a default nor a generated one. */
export async function tomarControlDeTui(
  sessionId: string,
  owner: TerminalSessionOwner,
  reason: string,
  session?: SesionConToken,
): Promise<ControlDeTuiTomado> {
  const body = await terminalRequest<unknown>(rutaDeSesion(sessionId, 'control'), {
    method: 'POST',
    body: JSON.stringify({ action: 'take', reason, ...cuerpoConDueno(owner) }),
  }, session);
  const record = recibo(
    body,
    'El gateway no acreditó la toma de control de la TUI.',
    'invalid_control_receipt',
  );
  const holdId = texto(record.hold_id);
  const heldBy = texto(record.held_by);
  const expiresAt = texto(record.expires_at);
  if (record.session_id !== sessionId || holdId === undefined || heldBy === undefined
      || expiresAt === undefined || !Number.isFinite(Date.parse(expiresAt))) {
    throw new TerminalApiError(
      'El gateway devolvió un arriendo de control ambiguo; no se asume que el teclado sea tuyo.',
      409,
      'invalid_control_receipt',
    );
  }
  return { session_id: sessionId, hold_id: holdId, held_by: heldBy, expires_at: expiresAt };
}

/**
 * Gives the keyboard back, with NO reason: the gateway stamps `operator_released`, the truth of a
 * release nobody typed. `keepalive` is what makes `beforeunload` work; a plain fetch dies there.
 */
export async function devolverControlDeTui(
  sessionId: string,
  owner: TerminalSessionOwner,
  session?: SesionConToken,
  opciones: { keepalive?: boolean } = {},
): Promise<ControlDeTuiDevuelto> {
  const body = await terminalRequest<unknown>(rutaDeSesion(sessionId, 'control'), {
    method: 'POST',
    body: JSON.stringify({ action: 'release', ...cuerpoConDueno(owner) }),
    ...(opciones.keepalive === true ? { keepalive: true } : {}),
  }, session);
  const record = recibo(
    body,
    'El gateway no acreditó la devolución del control de la TUI.',
    'invalid_control_receipt',
  );
  if (record.session_id !== sessionId || record.released !== true) {
    throw new TerminalApiError(
      'El gateway no confirmó que el control volviera al bus; el alias puede seguir en cola.',
      409,
      'invalid_control_receipt',
    );
  }
  return { session_id: sessionId, hold_id: texto(record.hold_id) ?? null };
}

/**
 * Pushes the window of the live session forward. It is an EXPLICIT act: nothing here runs on a
 * timer, because an extension emitted by a forgotten tab would keep an abandoned shell alive.
 */
export async function prorrogarSesion(
  sessionId: string,
  owner: TerminalSessionOwner,
  session?: SesionConToken,
): Promise<SesionProrrogada> {
  const body = await terminalRequest<unknown>(rutaDeSesion(sessionId, 'extend'), {
    method: 'POST',
    body: JSON.stringify(cuerpoConDueno(owner)),
  }, session);
  const record = recibo(
    body,
    'El gateway no acreditó la prórroga de la sesión PTY.',
    'invalid_extend_receipt',
  );
  const expiresAt = texto(record.expires_at);
  if (record.session_id !== sessionId || record.request_id !== owner.request_id
      || expiresAt === undefined || !Number.isFinite(Date.parse(expiresAt))) {
    throw new TerminalApiError(
      'El gateway devolvió una prórroga ambigua; la ventana de la sesión no se dio por movida.',
      409,
      'invalid_extend_receipt',
    );
  }
  return { session_id: sessionId, request_id: owner.request_id, expires_at: expiresAt };
}
