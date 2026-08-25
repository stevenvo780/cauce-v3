import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextoDeAlias } from '@cauce/protocol';
import { registerAgentProfileRoutes } from './agent-profile.routes.js';

/**
 * LA VISTA PREVIA DEL PERFIL, probada por donde puede MENTIR.
 *
 * El valor de esta ruta no es devolver JSON: es que lo que enseña sea, byte a byte, lo que va a
 * quedar escrito en el contenedor. Todo lo que se prueba acá defiende esa propiedad, más las dos
 * cosas que la ruta no puede saber y tiene que decir en vez de callarse.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

function contexto(parcial: Partial<ContextoDeAlias['perfil']>, harness: string): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: 'Steven', alias: 'zeus',
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: false, notificacion: true },
      cuotas: [{ proveedor: 'claude', cuenta: 'saldantia', limite: '3% semanal' }],
      arnes: { harness, home: '/home/dev', contenedor: 'ws-zeus', capacidades: ['bash', 'read'] },
      destinos: ['kant', 'argos']
    }
  } as ContextoDeAlias;
}

async function servidor(ctx: ContextoDeAlias | (() => Promise<never>)) {
  const app = Fastify();
  registerAgentProfileRoutes(app, {
    authorize: async () => ACTOR,
    readContext: typeof ctx === 'function' ? ctx : async () => ctx
  });
  await app.ready();
  return app;
}

let abierto: Awaited<ReturnType<typeof servidor>> | undefined;
afterEach(async () => { await abierto?.close(); abierto = undefined; });

describe('qué ficheros le tocan a cada arnés', () => {
  it('claude recibe UN fichero: CLAUDE.md', async () => {
    abierto = await servidor(contexto({ purpose: 'el médico de la flota' }, 'claude'));
    const res = await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' });
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json();
    expect(cuerpo.ficheros.map((f: { nombre: string }) => f.nombre)).toEqual(['CLAUDE.md']);
    expect(cuerpo.ficheros[0].texto).toContain('el médico de la flota');
  });

  it('codex recibe UN fichero: AGENTS.md', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'codex'));
    const res = await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' });
    expect(res.json().ficheros.map((f: { nombre: string }) => f.nombre)).toEqual(['AGENTS.md']);
  });

  it('openclaw recibe los SIETE, en el orden medido en la flota', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' });
    expect(res.json().ficheros.map((f: { nombre: string }) => f.nombre)).toEqual([
      'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md'
    ]);
  });
});

describe('el reparto de openclaw pone cada cara donde toca', () => {
  it('el propósito va a SOUL.md y el rol a IDENTITY.md, y NO al revés', async () => {
    /*
     * No es orden: es la diferencia entre enseñarle a un modelo quién es y enseñarle qué hace.
     * Un `SOUL.md` que hable de tareas le enseña que su identidad son sus tareas.
     */
    abierto = await servidor(contexto({
      purpose: 'existo para reparar Cauce', role_summary: 'médico de la flota'
    }, 'openclaw'));
    const ficheros: Array<{ nombre: string; texto: string }> = (await abierto.inject({
      method: 'GET', url: '/v3/console/agents/zeus/perfil'
    })).json().ficheros;
    const de = (nombre: string) => ficheros.find((f) => f.nombre === nombre)?.texto ?? '';

    expect(de('SOUL.md')).toContain('existo para reparar Cauce');
    expect(de('SOUL.md')).not.toContain('médico de la flota');
    expect(de('IDENTITY.md')).toContain('médico de la flota');
    expect(de('IDENTITY.md')).not.toContain('existo para reparar Cauce');
  });

  it('human_brief va a USER.md — el campo que no tenía camino', async () => {
    abierto = await servidor(contexto({ human_brief: 'Steven, directo y sin rodeos' }, 'openclaw'));
    const ficheros: Array<{ nombre: string; texto: string }> = (await abierto.inject({
      method: 'GET', url: '/v3/console/agents/zeus/perfil'
    })).json().ficheros;
    expect(ficheros.find((f) => f.nombre === 'USER.md')?.texto).toContain('Steven, directo y sin rodeos');
  });

  it('MEMORY.md y HEARTBEAT.md son DEL AGENTE: no reciben nada nuestro', async () => {
    /*
     * Pisarlos es borrarle la memoria a un compañero, y desde dentro del contenedor no hay marcha
     * atrás. La política tiene que viajar en la respuesta para que la pantalla lo pueda decir.
     */
    abierto = await servidor(contexto({
      purpose: 'p', role_summary: 'r', human_brief: 'h', tools: ['ssh'], operating_rules: ['no tocar credenciales']
    }, 'openclaw'));
    const ficheros: Array<{ nombre: string; politica: string; texto: string }> = (await abierto.inject({
      method: 'GET', url: '/v3/console/agents/zeus/perfil'
    })).json().ficheros;
    for (const nombre of ['MEMORY.md', 'HEARTBEAT.md']) {
      const fichero = ficheros.find((f) => f.nombre === nombre);
      expect(fichero?.politica).toBe('solo-si-falta');
      expect(fichero?.texto).toBe('');
    }
  });

  it('los permisos DENEGADOS se nombran igual que los concedidos', async () => {
    // Nombrar sólo lo concedido deja al agente adivinando si lo que falta es que no lo tiene o que
    // nadie lo escribió, y un agente que no sabe si puede hacer algo lo intenta.
    abierto = await servidor(contexto({ purpose: 'x' }, 'openclaw'));
    const ficheros: Array<{ nombre: string; texto: string }> = (await abierto.inject({
      method: 'GET', url: '/v3/console/agents/zeus/perfil'
    })).json().ficheros;
    const agents = ficheros.find((f) => f.nombre === 'AGENTS.md')?.texto ?? '';
    expect(agents).toContain('control): no');
    expect(agents).toContain('otros alias: sí');
  });
});

describe('lo que la ruta NO sabe, lo dice', () => {
  it('declara que la vista previa se compuso sobre fichero vacío', async () => {
    /*
     * El gateway no lee el disco del contenedor. Decir «así queda el fichero» sobre una medición
     * que no se hizo es la clase de mentira que cuesta un despliegue: alguien mira la vista previa,
     * no ve su manual escrito a mano, y concluye que se lo borraron.
     */
    abierto = await servidor(contexto({ purpose: 'x' }, 'claude'));
    expect((await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' })).json().base)
      .toBe('fichero-vacio');
  });

  it('un arnés desconocido devuelve CERO ficheros con el motivo, no un vacío mudo', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'hermes'));
    const cuerpo = (await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' })).json();
    expect(cuerpo.ficheros).toEqual([]);
    expect(cuerpo.aviso).toContain('hermes');
  });

  it('un perfil ENTERAMENTE vacío no produce un esqueleto de encabezados', async () => {
    /*
     * Los permisos y la configuración del arnés son hechos que SIEMPRE existen. Sin el corte, un
     * alias sin nada escrito recibiría un fichero que sólo le dice en qué contenedor corre: ruido
     * con forma de contrato.
     */
    abierto = await servidor(contexto({}, 'claude'));
    const ficheros: Array<{ texto: string }> = (await abierto.inject({
      method: 'GET', url: '/v3/console/agents/zeus/perfil'
    })).json().ficheros;
    expect(ficheros[0]?.texto).toBe('');
  });
});

describe('los topes del arnés se contestan con los dos números, no con un 500', () => {
  it('un openclaw pasado de tope devuelve 422 diciendo QUÉ fichero y cuánto mide', async () => {
    // «No entra» sobre siete ficheros no le dice a nadie qué recortar.
    abierto = await servidor(contexto({ purpose: 'x'.repeat(60_001) }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' });
    expect(res.statusCode).toBe(422);
    const cuerpo = res.json();
    expect(cuerpo.error).toBe('tope_del_arnes');
    expect(cuerpo.fichero).toBe('SOUL.md');
    expect(cuerpo.medido).toBeGreaterThan(cuerpo.tope);
  });

  it('CONTROL NEGATIVO: a claude NO se le inventa un tope que su arnés no declara', async () => {
    abierto = await servidor(contexto({ purpose: 'x'.repeat(60_001) }, 'claude'));
    expect((await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' })).statusCode)
      .toBe(200);
  });
});

describe('la guarda del alias', () => {
  it('un alias con forma inválida se rechaza ANTES de tocar la base', async () => {
    let consultada = false;
    const app = Fastify();
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      readContext: async () => { consultada = true; throw new Error('no debería llegar acá'); }
    });
    await app.ready();
    abierto = app;
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/..%2F..%2Fetc/perfil' });
    expect(res.statusCode).toBe(400);
    expect(consultada).toBe(false);
  });
});
