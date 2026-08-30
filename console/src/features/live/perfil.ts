import type {
  AgentPerfil, AgentPerfilAplicado, AgentPerfilCampos, AgentPerfilValor,
} from '../../api/types';

/**
 * THE PROFILE EDITOR LOGIC, separated from the paint so it can be tested on its own.
 *
 * The SEVEN authored fields of the alias (`agent_profiles`, migration 026) end up, word for word, in the
 * files READ by that alias's harness. Which file receives each field is NOT fixed: it is decided by
 * `ficherosDelArnes` in `@cauce/protocol` according to the harness, and `destinosDelArnes` reproduces that
 * distribution here so it can be labeled. `perfil.test.ts` ties the table to the real composition function,
 * which is what keeps them from drifting apart.
 *
 * Permissions, quotas, harness, and reachable aliases are NOT fields: they are FACTS read fresh from
 * `memberships`, `role_policies`, `provider_accounts`, and `agents`. They appear in the preview because they
 * go into the file, but they have no input box. Copying them as authored text would be a second source of
 * truth that silently desynchronizes: a permission gets revoked and the container's file keeps claiming it.
 *
 * The unit count is measured with `max(code points, UTF-16 units)`, the same thing the Postgres CHECK and
 * the compiler measure.
 */

/** Free-text fields, in the order they are painted. */
export const CAMPOS_DE_TEXTO = ['purpose', 'role_summary', 'human_brief'] as const;

/** List fields, in the order they are painted. */
export const CAMPOS_DE_LISTA = ['responsibilities', 'restrictions', 'tools', 'operating_rules'] as const;

type CampoDeTexto = (typeof CAMPOS_DE_TEXTO)[number];
type CampoDeLista = (typeof CAMPOS_DE_LISTA)[number];
export type CampoDelPerfil = CampoDeTexto | CampoDeLista;

export const CAMPOS_DEL_PERFIL: readonly CampoDelPerfil[] = [
  ...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA,
];

/**
 * How each field is named on screen, and what the operator is expected to put there.
 *
 * The help is not decoration: the column names are in English because the schema is, and `operating_rules`
 * does not tell anyone what to write. Without this, the operator fills `purpose` with what should go in
 * `role_summary`, and openclaw's `SOUL.md` ends up talking about tasks — which is exactly how you teach a
 * model that its identity is its tasks.
 */
export const ETIQUETAS: Record<CampoDelPerfil, { titulo: string; ayuda: string }> = {
  purpose: {
    titulo: 'Identidad y propósito',
    ayuda: 'Quién es este alias y para qué existe. No sus tareas: su razón de ser.',
  },
  role_summary: {
    titulo: 'Rol declarado',
    ayuda: 'Qué papel ocupa en la flota. Sucede al viejo role_brief, con sitio para el detalle que allá no cabía.',
  },
  human_brief: {
    titulo: 'Tu humano y cómo tratarlo',
    ayuda: 'Quién es la persona con la que trata y cómo quiere que le hablen.',
  },
  responsibilities: {
    titulo: 'Responsabilidades',
    ayuda: 'Qué le toca hacer. Una por línea.',
  },
  restrictions: {
    titulo: 'Restricciones',
    ayuda: 'Qué NO puede hacer, aunque pudiera. Una por línea.',
  },
  tools: {
    titulo: 'Herramientas',
    ayuda: 'Con qué cuenta, más allá de las capacidades del arnés. Una por línea.',
  },
  operating_rules: {
    titulo: 'Instrucciones fijas de funcionamiento',
    ayuda: 'Cómo se trabaja acá. Lo que hoy se reinyecta en cada mensaje y debería estar escrito una sola vez.',
  },
};

/** Where a field ends up: a named file, or an absence with the word it deserves. */
export type DestinoDelCampo =
  | { readonly tipo: 'fichero'; readonly nombre: string }
  | { readonly tipo: 'ausente'; readonly ausente: 'sin-dato' | 'no-aplica'; readonly motivo: string };

/** The only harness that splits the fields across several files; claude and codex merge them into one. */
const REPARTO_OPENCLAW: Record<CampoDelPerfil, string> = {
  purpose: 'SOUL.md',
  role_summary: 'IDENTITY.md',
  human_brief: 'USER.md',
  responsibilities: 'AGENTS.md',
  restrictions: 'AGENTS.md',
  tools: 'TOOLS.md',
  operating_rules: 'AGENTS.md',
};

function ficheroDelCampo(harness: string, campo: CampoDelPerfil): string | undefined {
  if (harness === 'claude') return 'CLAUDE.md';
  if (harness === 'codex') return 'AGENTS.md';
  if (harness === 'openclaw') return REPARTO_OPENCLAW[campo];
  return undefined;
}

/**
 * Which file each field goes to IN THIS alias, with the harness the server declares.
 *
 * A destination is only asserted if the harness is one Cauce knows how to compose AND the gateway publishes
 * that file among its own: labeling `SOUL.md` over a response that does not carry it would be promising a write
 * nobody will attest. A harness that is not claude, codex, or openclaw does not receive ANY file
 * —`nombresDelArnes` returns empty—, and that is stated, not substituted with openclaw.
 */
export function destinosDelArnes(
  harness: string | null | undefined,
  ficheros: readonly { nombre: string }[] | undefined,
): Record<CampoDelPerfil, DestinoDelCampo> {
  const arnes = typeof harness === 'string' ? harness.trim() : '';
  const publicados = new Set((ficheros ?? []).map((fichero) => fichero.nombre));
  const destinos = {} as Record<CampoDelPerfil, DestinoDelCampo>;
  for (const campo of CAMPOS_DEL_PERFIL) {
    const nombre = arnes.length === 0 ? undefined : ficheroDelCampo(arnes, campo);
    destinos[campo] = nombre !== undefined && publicados.has(nombre)
      ? { tipo: 'fichero', nombre }
      : { tipo: 'ausente', ...ausenciaDeDestino(arnes, nombre) };
  }
  return destinos;
}

function ausenciaDeDestino(
  arnes: string,
  nombre: string | undefined,
): { ausente: 'sin-dato' | 'no-aplica'; motivo: string } {
  if (arnes.length === 0) {
    return {
      ausente: 'sin-dato',
      motivo: 'El registro no dice qué arnés corre este alias, así que no se puede saber qué '
        + 'fichero lee.',
    };
  }
  if (nombre === undefined) {
    return {
      ausente: 'no-aplica',
      motivo: `Cauce no sabe qué fichero de contexto lee el arnés «${arnes}». Los que sabe `
        + 'escribir son claude, codex y openclaw.',
    };
  }
  return {
    ausente: 'sin-dato',
    motivo: `El arnés «${arnes}» escribiría ${nombre}, pero este gateway no lo publica entre sus `
      + 'ficheros gobernados, así que no se promete esa escritura.',
  };
}

/** The common reason when NO field has a destination; `undefined` as soon as one does. */
export function motivoSinDestino(
  destinos: Record<CampoDelPerfil, DestinoDelCampo>,
): string | undefined {
  const motivos = new Set<string>();
  for (const campo of CAMPOS_DEL_PERFIL) {
    const destino = destinos[campo];
    if (destino.tipo === 'fichero') return undefined;
    motivos.add(destino.motivo);
  }
  return [...motivos].join(' ');
}

/**
 * The count that RULES: the stricter of the two units. Same arithmetic as `measureStrictestUnits` in
 * `@cauce/protocol`, reimplemented because the console is a browser bundle and `@cauce/protocol` drags the
 * whole `zod` along; `perfil.test.ts` checks that the two yield the SAME number on the cases that separate one
 * unit from the other (BMP accents and emojis).
 */
export function contarUnidades(texto: string): number {
  return Math.max(Array.from(texto).length, texto.length);
}

/** What the operator has in front of them: the saved profile with the draft on top if there is one. */
export function camposVigentes(
  perfil: AgentPerfil | undefined,
  borrador: Partial<AgentPerfilCampos> | undefined,
): AgentPerfilCampos {
  const base: AgentPerfilCampos = {
    purpose: perfil?.perfil.purpose ?? '',
    role_summary: perfil?.perfil.role_summary ?? '',
    human_brief: perfil?.perfil.human_brief ?? '',
    responsibilities: [...(perfil?.perfil.responsibilities ?? [])],
    restrictions: [...(perfil?.perfil.restrictions ?? [])],
    tools: [...(perfil?.perfil.tools ?? [])],
    operating_rules: [...(perfil?.perfil.operating_rules ?? [])],
  };
  if (borrador === undefined) return base;
  return { ...base, ...borrador };
}

/** A list is edited as text, one entry per line. Blank lines are not entries. */
export function lineasALista(texto: string): string[] {
  return texto.split('\n').map((linea) => linea.trim()).filter((linea) => linea.length > 0);
}

export function listaALineas(items: readonly string[]): string {
  return items.join('\n');
}

/** Did anything change from what is saved? Compares value by value, not by object identity. */
export function hayCambios(
  perfil: AgentPerfil | undefined,
  campos: AgentPerfilCampos,
): boolean {
  const guardado = camposVigentes(perfil, undefined);
  for (const campo of CAMPOS_DE_TEXTO) {
    if (campos[campo] !== guardado[campo]) return true;
  }
  for (const campo of CAMPOS_DE_LISTA) {
    const a = campos[campo];
    const b = guardado[campo];
    if (a.length !== b.length) return true;
    if (a.some((item, i) => item !== b[i])) return true;
  }
  return false;
}

/**
 * What the whole profile measures, by the same criterion as migration 026's ceiling: it sums the texts and
 * EVERY entry of every list. A field within its own ceiling says nothing about the total: four full lists give
 * 256,000 units with every field "within its own".
 */
export function unidadesDelPerfil(campos: AgentPerfilCampos): number {
  let total = 0;
  for (const campo of CAMPOS_DE_TEXTO) total += contarUnidades(campos[campo]);
  for (const campo of CAMPOS_DE_LISTA) {
    for (const item of campos[campo]) total += contarUnidades(item);
  }
  return total;
}

/** Which fields exceed their ceiling, with the measured number. Empty = everything fits. */
export function camposQueNoEntran(
  campos: AgentPerfilCampos,
  limites: AgentPerfil['limites'] | undefined,
): { campo: string; medido: number; tope: number }[] {
  if (limites === undefined) return [];
  const fuera: { campo: string; medido: number; tope: number }[] = [];

  for (const campo of CAMPOS_DE_TEXTO) {
    const tope = campo === 'role_summary' ? limites.role_summary : limites.purpose;
    const medido = contarUnidades(campos[campo]);
    if (medido > tope) fuera.push({ campo: ETIQUETAS[campo].titulo, medido, tope });
  }

  for (const campo of CAMPOS_DE_LISTA) {
    const items = campos[campo];
    if (items.length > limites.items) {
      fuera.push({ campo: `${ETIQUETAS[campo].titulo} (nº de entradas)`, medido: items.length, tope: limites.items });
    }
    for (const item of items) {
      const medido = contarUnidades(item);
      if (medido > limites.item) {
        fuera.push({ campo: `${ETIQUETAS[campo].titulo} (una entrada)`, medido, tope: limites.item });
        break;
      }
    }
  }

  const total = unidadesDelPerfil(campos);
  if (total > limites.total) fuera.push({ campo: 'El perfil entero', medido: total, tope: limites.total });
  return fuera;
}

/** Canonical body of the applied route; it does not contain client-controlled identity or action. */
export function perfilParaGuardar(campos: AgentPerfilCampos): AgentPerfilValor {
  const texto = (valor: string): string | null => (valor.trim().length === 0 ? null : valor);
  return {
    purpose: texto(campos.purpose),
    role_summary: texto(campos.role_summary),
    human_brief: texto(campos.human_brief),
    responsibilities: [...campos.responsibilities],
    restrictions: [...campos.restrictions],
    tools: [...campos.tools],
    operating_rules: [...campos.operating_rules],
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A 2xx only attests application if the same revision converges and carries exactly one valid ACK per
 * expected file. It is validated at runtime because the remote JSON does not know the TS types.
 */
export function esPerfilAplicado(
  value: unknown,
  esperado: { tenantId: string; alias: string; nombres: readonly string[] },
): value is AgentPerfilAplicado {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || record.state !== 'applied'
    || record.tenant_id !== esperado.tenantId || record.alias !== esperado.alias
    || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
    || record.revision <= 0 || record.applied_revision !== record.revision
    || !Array.isArray(record.acknowledgements) || esperado.nombres.length === 0
    || record.acknowledgements.length !== esperado.nombres.length) return false;

  const pendientes = new Set(esperado.nombres);
  if (pendientes.size !== esperado.nombres.length) return false;
  let generation: string | undefined;
  const ackPorNombre = new Map<string, { path: string; sha: string }>();
  for (const rawAck of record.acknowledgements) {
    if (rawAck === null || typeof rawAck !== 'object' || Array.isArray(rawAck)) return false;
    const ack = rawAck as Record<string, unknown>;
    if (typeof ack.name !== 'string' || !pendientes.delete(ack.name)
      || typeof ack.path !== 'string' || !ack.path.startsWith('/')
      || !ack.path.endsWith(`/${ack.name}`)
      || !['written', 'already_current', 'preserved'].includes(String(ack.state))
      || typeof ack.sha !== 'string' || !SHA256.test(ack.sha)
      || typeof ack.bytes !== 'number' || !Number.isSafeInteger(ack.bytes) || ack.bytes < 0
      || typeof ack.generation !== 'string' || ack.generation.length === 0
      || (ack.container_id !== null
        && (typeof ack.container_id !== 'string' || ack.container_id.length === 0))) {
      return false;
    }
    generation ??= ack.generation;
    if (ack.generation !== generation) return false;
    ackPorNombre.set(ack.name, { path: ack.path, sha: ack.sha });
  }
  if (pendientes.size !== 0 || generation === undefined
    || record.runtime_adoption === null || typeof record.runtime_adoption !== 'object'
    || Array.isArray(record.runtime_adoption)) return false;
  const adoption = record.runtime_adoption as Record<string, unknown>;
  if (adoption.evidence !== 'adapter_delivery' || adoption.revision !== record.revision
    || adoption.generation !== generation || typeof adoption.adopted_at !== 'string'
    || !Number.isFinite(Date.parse(adoption.adopted_at))
    || !Array.isArray(adoption.documents)
    || adoption.documents.length !== ackPorNombre.size) return false;
  const adoptados = new Set(ackPorNombre.keys());
  for (const rawDocument of adoption.documents) {
    if (rawDocument === null || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
      return false;
    }
    const document = rawDocument as Record<string, unknown>;
    if (typeof document.name !== 'string' || !adoptados.delete(document.name)) return false;
    const ack = ackPorNombre.get(document.name);
    if (ack === undefined || document.path !== ack.path || document.sha !== ack.sha) return false;
  }
  return adoptados.size === 0;
}
