import { describe, expect, it } from 'vitest';
import type { AgentDocumentsMap, ConfigurationSnapshot } from '../../api/types';
import * as modulo from './capas-pendientes';
import {
  ROADMAP_DE_CAPAS, contrasteDeUbicacion, ubicacionDeclarada, ubicacionMedida,
} from './capas-pendientes';

/**
 * `agents.container_name` and `agents.home_directory` are DECLARED columns that
 * `docs/directiva-ficheros-del-agente.md` §3 documents as lying: for `iza` they say
 * `ws-humanizar` and `/home/dev` while the process runs in `claw-iza` with `HOME=/home/claw`.
 * Painting the declared value as the location sends the operator to edit the wrong file.
 */

const snapshot = (fila: Record<string, unknown>): ConfigurationSnapshot => ({ agents: [fila] });

const mapa = (extra: Partial<AgentDocumentsMap>): AgentDocumentsMap => ({
  publicado: true, facts_source: 'measured', harness: 'claude', home: '/home/claw', ...extra,
});

describe('ubicacionDeclarada', () => {
  it('carries the identity it was asked about, so the caller can measure the same alias', () => {
    const declarada = ubicacionDeclarada(
      snapshot({ tenant_id: 'Miguel', alias: 'iza', container_name: 'ws-humanizar', home_directory: '/home/dev' }),
      'Miguel', 'iza',
    );
    expect(declarada).toEqual({
      tenantId: 'Miguel', alias: 'iza', contenedor: 'ws-humanizar', home: '/home/dev',
    });
  });

  it('omits what the registry does not declare instead of inventing it', () => {
    const declarada = ubicacionDeclarada(
      snapshot({ tenant_id: 'Steven', alias: 'kant' }), 'Steven', 'kant',
    );
    expect(declarada).toEqual({ tenantId: 'Steven', alias: 'kant' });
  });

  it('does not take the row of another alias or another tenant', () => {
    const otro = snapshot({ tenant_id: 'Steven', alias: 'kant', home_directory: '/home/dev' });
    expect(ubicacionDeclarada(otro, 'Miguel', 'iza')).toEqual({ tenantId: 'Miguel', alias: 'iza' });
    expect(ubicacionDeclarada(undefined, 'Miguel', 'iza')).toEqual({ tenantId: 'Miguel', alias: 'iza' });
  });
});

describe('ubicacionMedida', () => {
  it('reads the measured $HOME and harness the documents map publishes', () => {
    expect(ubicacionMedida(mapa({}))).toEqual({ home: '/home/claw', arnes: 'claude' });
  });

  it('is empty when the source is deduced from the registry and not measured', () => {
    expect(ubicacionMedida(mapa({ facts_source: 'registry' }))).toEqual({});
    expect(ubicacionMedida(mapa({ facts_source: 'database' }))).toEqual({});
    expect(ubicacionMedida(mapa({ facts_source: undefined }))).toEqual({});
  });

  it('is empty when the gateway does not publish the route, and when there is no answer yet', () => {
    expect(ubicacionMedida(mapa({ publicado: false }))).toEqual({});
    expect(ubicacionMedida(undefined)).toEqual({});
  });

  it('treats an empty or blank measurement as absent, never as a measured empty $HOME', () => {
    expect(ubicacionMedida(mapa({ home: '', harness: '' }))).toEqual({});
    expect(ubicacionMedida(mapa({ home: '   ', harness: null as unknown as string }))).toEqual({});
  });
});

describe('contrasteDeUbicacion', () => {
  it('shows one value when the measurement confirms what the registry declares', () => {
    expect(contrasteDeUbicacion('/home/dev', '/home/dev')).toEqual({ estado: 'medido', valor: '/home/dev' });
  });

  it('shows both when they differ: that discrepancy IS the diagnosis', () => {
    expect(contrasteDeUbicacion('/home/dev', '/home/claw')).toEqual({
      estado: 'discrepa', declarado: '/home/dev', medido: '/home/claw',
    });
    expect(contrasteDeUbicacion('ws-humanizar', 'claw-iza')).toEqual({
      estado: 'discrepa', declarado: 'ws-humanizar', medido: 'claw-iza',
    });
  });

  it('without a measured fact it stays unknown and NEVER promotes the declared value', () => {
    const sinMedir = contrasteDeUbicacion('/home/dev', undefined);
    expect(sinMedir).toEqual({ estado: 'desconocido', declarado: '/home/dev' });
    expect(sinMedir).not.toHaveProperty('valor');
    expect(sinMedir).not.toHaveProperty('medido');
  });

  it('with neither fact it is unknown and carries nothing plausible', () => {
    expect(contrasteDeUbicacion(undefined, undefined)).toEqual({ estado: 'desconocido' });
  });

  it('a measurement without a declaration is still the measured value', () => {
    expect(contrasteDeUbicacion(undefined, '/home/claw')).toEqual({ estado: 'medido', valor: '/home/claw' });
  });
});

describe('the roadmap prose no longer travels in the SPA bundle', () => {
  it('exports no embedded roadmap list', () => {
    expect('CAPAS_PENDIENTES' in modulo).toBe(false);
  });

  it('points at the versioned section instead', () => {
    expect(ROADMAP_DE_CAPAS).toEqual({
      fichero: 'docs/roadmap.md', seccion: 'Capas pendientes del contexto',
    });
  });
});
