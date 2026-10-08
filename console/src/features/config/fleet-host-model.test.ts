import { describe, expect, it } from 'vitest';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { ApiError } from '../../api/client/core';
import { ejecutorDeComputadora, estadoDeComputadora, insigniaDeComputadora, mensajeDeEscritura, sePuedeEliminar } from './fleet-host-model';

const base = {
  host_id: 'uno', display_name: 'Uno', notes: '', enabled: true, status: 'reachable', status_source: 'controller',
  last_seen_at: null, registered: true, approved: true, version: 1, agents: [],
} as FleetHost;

describe('estado de la computadora', () => {
  it('traduce cada estado y explica de qué fuente sale', () => {
    expect(estadoDeComputadora(base)).toEqual({ etiqueta: 'Conectada', tono: 'ok', fuente: 'según el controlador de flota' });
    expect(estadoDeComputadora({ ...base, status: 'unreachable', status_source: 'agents' }))
      .toEqual({ etiqueta: 'Sin conexión', tono: 'danger', fuente: 'según los latidos de sus agentes' });
    expect(estadoDeComputadora({ ...base, status: 'unknown', status_source: 'none' }).etiqueta).toBe('Sin datos');
  });

  it('distingue el ejecutor aprobado del pendiente', () => {
    expect(ejecutorDeComputadora(base)).toBe('Aprobada para crear agentes');
    expect(ejecutorDeComputadora({ ...base, approved: false }))
      .toBe('Pendiente: falta instalar y aprobar el ejecutor en esta computadora');
  });
});

it('solo se elimina una computadora registrada y sin agentes', () => {
  expect(sePuedeEliminar(base)).toBe(true);
  expect(sePuedeEliminar({ ...base, registered: false })).toBe(false);
  expect(sePuedeEliminar({ ...base, agents: [{ tenant_id: 'A', alias: 'w', enabled: true, online: false }] })).toBe(false);
});

it('409 significa un duplicado al crear, un conflicto de versión al editar y también agentes al borrar', () => {
  const conflicto = new ApiError('conflict', 409);
  expect(mensajeDeEscritura(conflicto, 'alta')).toBe('Ya existe una computadora con ese identificador.');
  expect(mensajeDeEscritura(conflicto)).toBe('Otro operador cambió esta computadora; relee.');
  expect(mensajeDeEscritura(conflicto, 'edicion')).toBe('Otro operador cambió esta computadora; relee.');
  expect(mensajeDeEscritura(conflicto, 'baja')).toBe('Otro operador cambió esta computadora o todavía tiene agentes; relee antes de reintentar.');
  expect(mensajeDeEscritura(new ApiError('nf', 404))).toBe('Esta computadora ya no existe; relee la lista.');
  expect(mensajeDeEscritura(new ApiError('forbidden', 403))).toBe('Tu sesión no puede cambiar las computadoras.');
  expect(mensajeDeEscritura(new Error('red caída'))).toBe('red caída');
});

describe('insignia de la computadora de un agente', () => {
  it('no marca una computadora usable ni sin datos del controlador', () => {
    expect(insigniaDeComputadora(base)).toBeUndefined();
    expect(insigniaDeComputadora(undefined)).toBeUndefined();
  });

  it('distingue la computadora deshabilitada de la que está sin conexión', () => {
    expect(insigniaDeComputadora({ ...base, enabled: false })).toBe('Deshabilitado: computadora deshabilitada');
    expect(insigniaDeComputadora({ ...base, status: 'unreachable', status_source: 'agents' })).toBe('Deshabilitado: computadora sin conexión');
  });
});
