import { fleetHostOffline, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { ApiError } from '../../api/client/core';
import type { Tone } from '../../status-tone';

const ESTADO: Record<FleetHost['status'], { etiqueta: string; tono: Tone }> = {
  reachable: { etiqueta: 'Conectada', tono: 'ok' },
  unreachable: { etiqueta: 'Sin conexión', tono: 'danger' },
  unknown: { etiqueta: 'Sin datos', tono: 'neutral' },
};

const FUENTE: Record<FleetHost['status_source'], string> = {
  controller: 'según el controlador de flota',
  agents: 'según los latidos de sus agentes',
  none: 'ningún controlador ni agente lo ha reportado',
};

export function estadoDeComputadora(host: FleetHost): { etiqueta: string; tono: Tone; fuente: string } {
  return { ...ESTADO[host.status], fuente: FUENTE[host.status_source] };
}

export function ejecutorDeComputadora(host: FleetHost): string {
  return host.approved
    ? 'Aprobada para crear agentes'
    : 'Pendiente: falta instalar y aprobar el ejecutor en esta computadora';
}

export function sePuedeEliminar(host: FleetHost): boolean {
  return host.registered && host.agents.length === 0;
}

/** Badge on an agent row placed on a computer that cannot run it now. Informational: it never blocks an action. */
export function insigniaDeComputadora(host: FleetHost | undefined): string | undefined {
  if (!host) return undefined;
  if (!host.enabled) return 'Deshabilitado: computadora deshabilitada';
  return fleetHostOffline(host) ? 'Deshabilitado: computadora sin conexión' : undefined;
}

export type AccionDeEscritura = 'alta' | 'edicion' | 'baja';

/** A 409 means a different thing per action: a duplicate id on create, a stale version on edit, and on delete it also covers "still has agents". */
export function mensajeDeEscritura(error: unknown, accion: AccionDeEscritura = 'edicion'): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 409) {
    if (accion === 'alta') return 'Ya existe una computadora con ese identificador.';
    return accion === 'baja'
      ? 'Otro operador cambió esta computadora o todavía tiene agentes; relee antes de reintentar.'
      : 'Otro operador cambió esta computadora; relee.';
  }
  if (status === 404) return 'Esta computadora ya no existe; relee la lista.';
  if (status === 403) return 'Tu sesión no puede cambiar las computadoras.';
  return error instanceof Error ? error.message : 'No se pudo guardar el cambio.';
}
