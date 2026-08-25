import type { FastifyInstance } from 'fastify';
import {
  AGENT_PROFILE_LIMITS, agentProfileUnits, ficherosDelArnes, nombresDelArnes,
  type AgentProfile, type ContextoDeAlias, type FicheroGenerado
} from '@cauce/protocol';

/**
 * LA VISTA PREVIA DEL PERFIL: qué va a quedar escrito, fichero por fichero, ANTES de escribirlo.
 *
 * ============================================================================================
 * QUÉ PROBLEMA RESUELVE
 * ============================================================================================
 * La consola ya deja editar ocho campos del alias. De los ocho, el 2026-08-24 sólo `role_brief`
 * tenía un lector real en la ejecución: los otros siete se guardaban en la base y no llegaban a
 * ningún sitio. El operador escribía, la pantalla decía «guardado», y el agente seguía sin
 * enterarse — sin un solo error por ningún lado.
 *
 * Esta ruta cierra la mitad que faltaba del lazo: dado un alias, devuelve EL TEXTO EXACTO que va a
 * quedar en cada fichero que su arnés lee. Para `claude` es `CLAUDE.md`; para `codex`,
 * `AGENTS.md`; para `openclaw`, los SIETE Markdown de su espacio de trabajo, cada uno con la cara
 * del perfil que le toca.
 *
 * ============================================================================================
 * POR QUÉ SALE DE LA MISMA FUNCIÓN QUE LA SIEMBRA
 * ============================================================================================
 * `ficherosDelArnes()` es la que usa el adaptador dentro del contenedor para escribir. Acá se
 * llama a ESA, no a una copia. Si el servidor compusiera el texto por su cuenta, las dos
 * implementaciones divergirían a la primera corrección y el operador aprobaría un bloque distinto
 * del que acaba en el disco, sin que nada diera error. Es todo el motivo por el que el reparto
 * vive en `@cauce/protocol` y no en `@cauce/adapter-sdk`.
 *
 * ============================================================================================
 * LO QUE ESTA RUTA NO PUEDE SABER, Y LO DICE
 * ============================================================================================
 * El gateway NO lee el disco del contenedor. Así que la vista previa se compone sobre fichero
 * VACÍO: enseña el bloque gestionado y nada más. Lo que una persona haya escrito a mano en su
 * `CLAUDE.md` sigue ahí y NO se toca —la fusión conserva lo de fuera byte a byte—, pero esta
 * respuesta no puede mostrarlo porque no lo ha visto.
 *
 * `base` lo dice con esas palabras en vez de dejar que el operador crea que el fichero entero es
 * lo que ve. Decir «así queda el fichero» sobre una medición que no se hizo es la clase de mentira
 * que cuesta un despliegue: alguien mira la vista previa, no ve su manual, y concluye que se lo
 * borraron.
 */

/** De dónde salen el perfil y los hechos. Inyectable para poder probar la ruta sin base. */
export interface AgentProfileDeps {
  /** Resuelve el principal y exige el permiso, igual que el resto de `/v3/console`. */
  authorize(request: unknown): Promise<{ tenant_id: string; alias: string }>;
  /** El perfil autorado más los hechos derivados, de una pieza. */
  readContext(tenantId: string, alias: string): Promise<ContextoDeAlias>;
}

/** De qué está compuesta la vista previa: nunca de una medición que no se hizo. */
export type BaseDeLaVistaPrevia = 'fichero-vacio';

export interface FicheroDeLaVistaPrevia {
  readonly nombre: string;
  readonly politica: FicheroGenerado['politica'];
  readonly texto: string;
  /**
   * Unidades del texto, en la misma cuenta que usan el CHECK de Postgres y los topes de openclaw.
   * Va medido y no se deja al navegador: dos cuentas del mismo número son dos sitios donde
   * discrepar, y la discrepancia de agosto dejó un alias sordo.
   */
  readonly unidades: number;
}

export interface RespuestaDelPerfil {
  readonly tenant_id: string;
  readonly alias: string;
  /** El arnés MEDIDO en los hechos. `null` cuando el registro no dice ninguno. */
  readonly harness: string | null;
  readonly perfil: AgentProfile;
  readonly hechos: ContextoDeAlias['hechos'];
  readonly limites: typeof AGENT_PROFILE_LIMITS;
  /** Lo que mide el perfil entero contra su techo. El navegador pinta la barra con esto. */
  readonly medida: { readonly unidades: number; readonly tope: number };
  readonly base: BaseDeLaVistaPrevia;
  readonly ficheros: readonly FicheroDeLaVistaPrevia[];
  /**
   * Por qué no hay ficheros, cuando no los hay. Un array vacío sin explicación se lee como «este
   * alias no tiene contexto», y lo que pasa de verdad es que su arnés no es de los que Cauce sabe
   * escribir — que es una cosa muy distinta y se arregla en otro sitio.
   */
  readonly aviso?: string;
}

/**
 * Un tope superado NO es un 500: es una respuesta con el fichero y los dos números.
 *
 * `ficherosDelArnes` lanza `ErrorDeTopeDelArnes` antes de devolver nada cuando un fichero de
 * openclaw —o la suma de los siete— se pasa de lo que ese arnés declara. Lanzar está bien: escribir
 * una persona a medias es peor que no escribirla. Pero el operador necesita saber CUÁL recortar, y
 * un 500 con «internal error» no se lo dice.
 */
export interface TopeSuperado {
  readonly error: 'tope_del_arnes';
  readonly fichero: string;
  readonly medido: number;
  readonly tope: number;
  readonly message: string;
}

function esTopeSuperado(error: unknown): error is Error & { fichero: string; medido: number; tope: number } {
  return error instanceof Error && error.name === 'ErrorDeTopeDelArnes'
    && 'fichero' in error && 'medido' in error && 'tope' in error;
}

/** La misma cuenta que el CHECK de Postgres y que `String.length`. Ver `measureStrictestUnits`. */
function unidades(texto: string): number {
  return Math.max([...texto].length, texto.length);
}

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileDeps): void {
  app.get<{ Params: { alias: string } }>(
    '/v3/console/agents/:alias/perfil',
    async (request, reply) => {
      const actor = await deps.authorize(request);
      const alias = request.params.alias;
      if (!/^[a-z][a-z0-9_-]{1,63}$/.test(alias)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'alias is invalid' });
      }

      const contexto = await deps.readContext(actor.tenant_id, alias);
      const harness = contexto.hechos.arnes.harness;
      const nombres = nombresDelArnes(harness ?? '');

      const comun = {
        tenant_id: actor.tenant_id,
        alias,
        harness: harness ?? null,
        perfil: contexto.perfil,
        hechos: contexto.hechos,
        limites: AGENT_PROFILE_LIMITS,
        medida: { unidades: agentProfileUnits(contexto.perfil), tope: AGENT_PROFILE_LIMITS.total },
        base: 'fichero-vacio' as const
      };

      if (nombres.length === 0) {
        const respuesta: RespuestaDelPerfil = {
          ...comun,
          ficheros: [],
          aviso: harness === null || harness === undefined
            ? 'El registro no dice qué arnés corre este alias, así que no se puede saber qué fichero lee.'
            : `Cauce no sabe qué fichero de contexto lee el arnés «${harness}». Los que sabe escribir son claude, codex y openclaw.`
        };
        return respuesta;
      }

      try {
        /*
         * `existentes` va VACÍO a propósito: el gateway no lee el disco del contenedor. Ver el
         * encabezado — la respuesta lo declara en `base` para que la pantalla no pueda enseñar
         * esto como «el fichero entero».
         */
        const generados = ficherosDelArnes(harness ?? '', contexto, new Map());
        const respuesta: RespuestaDelPerfil = {
          ...comun,
          ficheros: generados.map((fichero) => ({
            nombre: fichero.nombre,
            politica: fichero.politica,
            texto: fichero.texto,
            unidades: unidades(fichero.texto)
          }))
        };
        return respuesta;
      } catch (error) {
        if (esTopeSuperado(error)) {
          const cuerpo: TopeSuperado = {
            error: 'tope_del_arnes',
            fichero: error.fichero,
            medido: error.medido,
            tope: error.tope,
            message: error.message
          };
          return reply.code(422).send(cuerpo);
        }
        throw error;
      }
    }
  );
}
