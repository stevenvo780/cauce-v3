import {
  emptyAgentProfile, normalizeAgentProfile, type AgentProfile
} from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';

/**
 * EL PERFIL POR ALIAS: leer y escribir la fuente de verdad de lo que va al fichero del arnés.
 *
 * La tabla es `agent_profiles` (migración 026) y la forma y los topes son los de
 * `packages/protocol/src/agent-profile.ts`. Este módulo no decide nada sobre el contenido: valida
 * con `normalizeAgentProfile` —la MISMA guarda que usa cualquier otra capa— y persiste.
 *
 * POR QUÉ ES UNA CLASE Y NO UNA FUNCIÓN SUELTA: es la misma forma que `ConfigurationRepository`,
 * porque es la misma clase de objeto —una superficie coherente de lectura y escritura sobre una
 * tabla de configuración— y porque la pantalla que lo va a usar ya sostiene un repositorio así.
 *
 * POR QUÉ NO TOCA `config_revisions`: a diferencia de `role_brief`, ningún otro camino escribe
 * `agent_profiles`, así que no hay una segunda pantalla que pueda pisar esta escritura con un
 * `expected_revision` viejo. Cuando el perfil entre en la pantalla de configuración habrá que
 * sumarlo a la revisión, y ése es el momento de hacerlo, no antes: una revisión que nadie compara
 * es ceremonia.
 *
 * POR QUÉ NO LEE PERMISOS NI CUOTAS: no son de esta tabla. Los permisos viven en `memberships` +
 * `role_policies`, las cuotas en `provider_accounts`, y la configuración del arnés en `agents` +
 * `harness_definitions`. El compilador los recibe como HECHOS y los une; duplicarlos acá sería
 * fabricar una segunda fuente de verdad que se desincroniza en silencio.
 */

/** Las columnas, en el orden de la tabla. Una sola copia para el SELECT y para el RETURNING. */
const profileColumns =
  'tenant_id,alias,purpose,role_summary,responsibilities,restrictions,tools,operating_rules';

interface ProfileRow {
  tenant_id: string;
  alias: string;
  purpose: string | null;
  role_summary: string | null;
  responsibilities: string[] | null;
  restrictions: string[] | null;
  tools: string[] | null;
  operating_rules: string[] | null;
}

/**
 * Una fila de Postgres se convierte en `AgentProfile` SIN volver a validar.
 *
 * Deliberado: lo que está en la base ya pasó los CHECK de la migración 026, y re-validarlo al
 * leerlo convertiría un tope bajado en el futuro en una lectura que EXPLOTA sobre datos que la
 * base considera legítimos. Un perfil guardado se lee siempre; lo que se valida es lo que ENTRA.
 *
 * `?? []` sobre los arrays no es defensa vacía: las columnas son NOT NULL DEFAULT '{}', pero `pg`
 * devuelve `null` para un array ausente en un RETURNING parcial, y un `null` que llegue como lista
 * rompería el compilador en un `for...of`.
 */
function toProfile(row: ProfileRow): AgentProfile {
  return {
    tenant_id: row.tenant_id,
    alias: row.alias,
    purpose: row.purpose,
    role_summary: row.role_summary,
    responsibilities: row.responsibilities ?? [],
    restrictions: row.restrictions ?? [],
    tools: row.tools ?? [],
    operating_rules: row.operating_rules ?? []
  };
}

export class AgentProfileRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * El perfil de un alias. Un alias SIN fila devuelve un perfil vacío, no un error.
   *
   * Es lo que hace que el compilador pueda correr sobre los quince alias desde el primer día: la
   * ausencia de perfil es un estado legítimo —«todavía no se escribió»— y no una avería. El
   * compilador omite las secciones vacías, así que un perfil en blanco produce un bloque sin
   * secciones y nunca un fichero con encabezados huecos.
   */
  async read(tenantId: string, alias: string): Promise<AgentProfile> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT ${profileColumns} FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`,
      [tenantId, alias]
    );
    const row = result.rows[0];
    return row === undefined ? emptyAgentProfile(tenantId, alias) : toProfile(row);
  }

  /** Los perfiles de varios alias de un tenant, para generar la flota entera de una pasada. */
  async readMany(tenantId: string, aliases: readonly string[]): Promise<Map<string, AgentProfile>> {
    const profiles = new Map<string, AgentProfile>();
    for (const alias of aliases) profiles.set(alias, emptyAgentProfile(tenantId, alias));
    if (aliases.length === 0) return profiles;
    const result = await this.pool.query<ProfileRow>(
      `SELECT ${profileColumns} FROM agent_profiles WHERE tenant_id=$1 AND alias = ANY($2::text[])`,
      [tenantId, [...aliases]]
    );
    for (const row of result.rows) profiles.set(row.alias, toProfile(row));
    return profiles;
  }

  /**
   * Escribe el perfil entero. Es un REEMPLAZO, no un parche.
   *
   * Reemplazo y no parche porque el presupuesto TOTAL sólo se puede comprobar sobre el perfil
   * completo: un parche que sube `tools` sin ver `purpose` no puede saber si la suma entra, y la
   * base lo rechazaría con un error sobre un campo que el que escribe ni mandó.
   *
   * La validación ocurre ANTES de abrir la transacción, a propósito: un perfil inadmisible no
   * merece un `BEGIN`, y así el error que ve la pantalla es el de `AgentProfileError` —que nombra
   * el CAMPO— y no un `23514` de Postgres que sólo nombra el constraint.
   */
  async write(input: Record<string, unknown>): Promise<AgentProfile> {
    const profile = normalizeAgentProfile(input);
    return withTransaction(this.pool, (client) => this.writeWithClient(client, profile));
  }

  private async writeWithClient(
    client: DatabaseClient, profile: AgentProfile
  ): Promise<AgentProfile> {
    const result = await client.query<ProfileRow>(
      `INSERT INTO agent_profiles
         (tenant_id,alias,purpose,role_summary,responsibilities,restrictions,tools,operating_rules)
       VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7::text[],$8::text[])
       ON CONFLICT (tenant_id,alias) DO UPDATE SET
         purpose=EXCLUDED.purpose,
         role_summary=EXCLUDED.role_summary,
         responsibilities=EXCLUDED.responsibilities,
         restrictions=EXCLUDED.restrictions,
         tools=EXCLUDED.tools,
         operating_rules=EXCLUDED.operating_rules,
         updated_at=now()
       RETURNING ${profileColumns}`,
      [
        profile.tenant_id, profile.alias, profile.purpose, profile.role_summary,
        [...profile.responsibilities], [...profile.restrictions],
        [...profile.tools], [...profile.operating_rules]
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`agent profile write returned no row for ${profile.tenant_id}/${profile.alias}`);
    }
    return toProfile(row);
  }

  /**
   * Borra el perfil. Devuelve si había algo que borrar.
   *
   * Devuelve `false` en vez de fallar cuando no había fila: borrar lo que ya no está es el
   * resultado que se pedía. Lo que NO hace es mentir `true`, porque la pantalla que lo llame
   * necesita poder distinguir «lo borré» de «no había nada», y un `true` incondicional le
   * enseñaría que borró algo que nunca existió.
   *
   * NO toca `agents.role_brief`: el alias conserva su identidad en el sobre de la entrega aunque
   * se quede sin perfil.
   */
  async remove(tenantId: string, alias: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenantId, alias]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
