import type { ConfigMutation } from '../../api/types';


/** Column order for collections with a known shape; the rest derive from the rows. */
const COLUMNAS_FIJAS: Record<string, readonly string[]> = {
  tenants: ['id', 'display_name', 'is_hub', 'enabled', 'created_at'],
  rooms: ['tenant_id', 'id', 'display_name', 'enabled', 'created_at'],
  memberships: ['tenant_id', 'room_id', 'alias', 'role', 'enabled', 'created_at'],
  acl_edges: ['from_tenant', 'to_tenant', 'enabled', 'allow_route', 'allow_read', 'allow_control', 'created_at'],
};

const ETIQUETAS: Record<string, string> = {
  id: 'Id', tenant_id: 'Tenant', room_id: 'Room', alias: 'Alias', role: 'Rol de permisos',
  display_name: 'Nombre', is_hub: 'Hub', enabled: 'Habilitado',
  created_at: 'Alta', updated_at: 'Última edición',
  from_tenant: 'Desde', to_tenant: 'Hacia',
  allow_route: 'Ruta', allow_read: 'Lectura', allow_control: 'Control',
  allow_notify: 'Aviso proactivo', harness_id: 'Harness', command: 'Comando',
  capabilities: 'Capacidades', handle: 'Handle', adapter: 'Adaptador', channel: 'Canal',
  provider: 'Proveedor', account_id: 'Cuenta', agent_alias: 'Alias', priority: 'Prioridad',
  role_brief: 'Rol declarado (diagnóstico)', label: 'Etiqueta',
  container_name: 'Contenedor', runtime_user: 'Usuario', home_directory: 'Carpeta personal',
  image_id: 'Imagen', generation: 'Generación',
  protocol_version: 'Protocolo', last_seen_at: 'Última señal', connected_since: 'Conectado desde',
  payer_tenant_id: 'Paga', shared_with_pool: 'En el pool', external_account_id: 'Id externo',
  credential_ref: 'Credencial', credential_ref_kind: 'Tipo de credencial', plan: 'Plan',
  account_label: 'Cuenta', window_key: 'Ventana', group_key: 'Grupo',
  max_priority: 'Prioridad máxima', rank: 'Orden', notes: 'Notas', reason: 'Motivo',
  expires_at: 'Vence', paused_until: 'Pausada hasta', paused_reason: 'Motivo de la pausa',
  progress_relay_enabled: 'Relé de progreso', progress_relay_max_events: 'Eventos por relé',
  cycle_cut_enabled: 'Corte de ciclos', failure_coalesce_enabled: 'Agrupar fallos',
  failure_coalesce_window_seconds: 'Ventana de agrupación', delegation_caps_enabled: 'Topes de delegación',
  max_fanout_per_turn: 'Abanico por turno', max_edge_repeats_per_root: 'Repeticiones de arista',
  max_delegations_per_root: 'Delegaciones por raíz', human_gate_enabled: 'Compuerta humana',
};

const segundosALegible = (valor: unknown): string | undefined => {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return undefined;
  if (valor >= 3600 && valor % 3600 === 0) return `${String(valor / 3600)} h`;
  if (valor >= 60 && valor % 60 === 0) return `${String(valor / 60)} min`;
  return `${String(valor)} s`;
};

const numero = (valor: unknown): string | undefined => (typeof valor === 'number' && Number.isFinite(valor) ? String(valor) : undefined);

/**
 * Secondary fields printed under the flag that governs them instead of as a column of their own:
 * a limit that only matters while its flag is on reads as one fact, and eleven columns do not fit
 * a desktop. The raw values stay reachable in "Ver crudo".
 */
const CAMPOS_PLEGADOS: Record<string, Record<string, readonly { campo: string; formato: (valor: unknown) => string | undefined }[]>> = {
  chain_policies: {
    progress_relay_enabled: [{ campo: 'progress_relay_max_events', formato: (v) => { const n = numero(v); return n && `hasta ${n} eventos`; } }],
    failure_coalesce_enabled: [{ campo: 'failure_coalesce_window_seconds', formato: (v) => { const t = segundosALegible(v); return t && `ventana de ${t}`; } }],
    delegation_caps_enabled: [
      { campo: 'max_fanout_per_turn', formato: (v) => { const n = numero(v); return n && `${n} por turno`; } },
      { campo: 'max_edge_repeats_per_root', formato: (v) => { const n = numero(v); return n && `${n} por arista`; } },
      { campo: 'max_delegations_per_root', formato: (v) => { const n = numero(v); return n && `${n} por raíz`; } },
    ],
  },
};

function plegadosDe(coleccion: string): Record<string, readonly { campo: string; formato: (valor: unknown) => string | undefined }[]> {
  return Object.hasOwn(CAMPOS_PLEGADOS, coleccion) ? CAMPOS_PLEGADOS[coleccion] : {};
}

/** The folded values of a column for one row, in reading order; empty when nothing folds into it or its flag is off. */
export function detalleDeColumna(coleccion: string, columna: string, fila: Record<string, unknown>): string[] {
  const plegados = plegadosDe(coleccion);
  if (!Object.hasOwn(plegados, columna) || fila[columna] === false) return [];
  return plegados[columna].map((parte) => parte.formato(fila[parte.campo])).filter((parte): parte is string => parte !== undefined);
}

const IDENTIDAD_FUNDIDA: Record<string, { clave: string; etiqueta: string; campos: readonly string[]; union: string }> = {
  acl_edges: { clave: '__arista', etiqueta: 'Arista', campos: ['from_tenant', 'to_tenant'], union: ' → ' },
};

/** The text of a merged column, or `undefined` if this row lacks the fields that compose it. */
export function identidadFundida(clave: string, fila: Record<string, unknown>): string | undefined {
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  if (!fusion) return undefined;
  const partes = fusion.campos.map((campo) => texto(fila, campo));
  return partes.every((parte) => parte !== undefined) ? partes.join(fusion.union) : undefined;
}

export function esColumnaFundida(clave: string, columna: string): boolean {
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  return fusion?.clave === columna;
}

export interface ColumnaTabla {
  clave: string;
  etiqueta: string;
}

/** Fields formatted as dates rather than plain text. */
export function esColumnaDeFecha(clave: string): boolean {
  return clave === 'created_at' || clave === 'updated_at';
}

/**
 * Fields that carry a PARAGRAPH, not a value. `role_brief` allows up to 1200 chars in the database,
 * and dumping it whole in a cell pushes the other eleven columns of "Agent registry" off-screen:
 * a row becomes unreadable because of a field you do not edit here.
 *
 * The full text is not lost: it remains in the cell's `title`, in the "Ver crudo" dropdown of the
 * collection, and is shown as a read-only diagnostic in the «Directiva» section of the agent's
 * context page. That page owns context changes. Here it is enough to see the projection summarised.
 */
const COLUMNAS_LARGAS: ReadonlySet<string> = new Set(['role_brief']);

export function esColumnaLarga(clave: string): boolean {
  return COLUMNAS_LARGAS.has(clave);
}

/** How many characters of a long field fit in a cell before truncating. */
const LARGO_DE_RESUMEN = 120;

/**
 * Visible truncation. The trailing "..." is not decorative: it is the only signal that what you are
 * reading is NOT the full value, and without it a truncated brief is mistaken for a short one.
 *
 * It counts code points (`[...texto]`) instead of UTF-16 units, like the counter in the "Rol" tab:
 * cutting an emoji in half would leave a broken character on screen.
 */
export function resumirTextoLargo(valor: string, largo: number = LARGO_DE_RESUMEN): string {
  const puntos = Array.from(valor);
  return puntos.length <= largo ? valor : `${puntos.slice(0, largo).join('')}…`;
}

/**
 * A column is only drawn if at least one row CARRIES the key. A `created_at` that the gateway does
 * not publish should not appear as a full column of UNKNOWN: that is not missing data per row, it
 * is a column this server does not have.
 */
export function columnasDe(clave: string, filas: readonly Record<string, unknown>[]): ColumnaTabla[] {
  const fijas = COLUMNAS_FIJAS[clave] ?? [];
  const presentes = fijas.filter((campo) => filas.some((fila) => Object.hasOwn(fila, campo)));
  const extra: string[] = [];
  for (const fila of filas) {
    for (const campo of Object.keys(fila)) {
      if (!presentes.includes(campo) && !extra.includes(campo)) extra.push(campo);
    }
  }
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  const fundir = Boolean(fusion?.campos.every((campo) => presentes.includes(campo)));
  const orden = fundir && fusion
    ? [fusion.clave, ...presentes.filter((campo) => !fusion.campos.includes(campo)), ...extra]
    : [...presentes, ...extra];
  // A folded field only disappears while the flag it folds under is also a column: otherwise it
  // would vanish with nothing showing it.
  const plegados = plegadosDe(clave);
  const ocultos = new Set(Object.entries(plegados)
    .filter(([padre]) => orden.includes(padre))
    .flatMap(([, partes]) => partes.map((parte) => parte.campo)));
  return orden.filter((campo) => !ocultos.has(campo)).map((campo) => ({
    clave: campo,
    etiqueta: fundir && campo === fusion?.clave
      ? fusion.etiqueta
      : Object.hasOwn(ETIQUETAS, campo) ? ETIQUETAS[campo] : campo,
  }));
}

/**
 * Whether a column is NUMERIC, to right-align it.
 *
 * A left-aligned number column forces comparing magnitudes by counting digits: `8` and `120`
 * start at the same pixel and the one that LOOKS bigger is the one with more characters. `/config`
 * has a few —`max_per_hour`, `max_per_day`, `contact_ttl_days`, `min_interval_seconds`, `priority`,
 * `generation`— and they are all read for comparison.
 *
 * Requires EVERY present value to be a number and at least one: a mixed column ("12" in one row
 * and "sin límite" in another) reads worse right-aligned than left, and a JavaScript boolean is
 * not a number but looks like one if you glance at `typeof` in a hurry. Nulls and missing keys
 * do not count: a `null` does not disprove a numeric column.
 */
export function columnaNumerica(filas: readonly Record<string, unknown>[], columna: string): boolean {
  let vistos = 0;
  for (const fila of filas) {
    if (!Object.hasOwn(fila, columna)) continue;
    const valor = fila[columna];
    if (valor === null || valor === undefined) continue;
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return false;
    vistos += 1;
  }
  return vistos > 0;
}

/** Fields identifying a row in each collection, in primary-key order. */
const IDENTIDAD: Record<string, readonly string[]> = {
  tenants: ['id'],
  rooms: ['tenant_id', 'id'],
  memberships: ['tenant_id', 'room_id', 'alias'],
  acl_edges: ['from_tenant', 'to_tenant'],
  harness_definitions: ['id'],
  role_policies: ['role'],
  chain_policies: ['id'],
  egress_destinations: ['tenant_id', 'alias', 'handle'],
  agents: ['tenant_id', 'alias'],
  provider_accounts: ['id'],
  alias_routing_ceiling: ['tenant_id', 'alias', 'account_id'],
  agent_account_bindings: ['tenant_id', 'agent_alias', 'account_id'],
};

/**
 * React key of a row. The index is the last resort, not the first: reordering the list with index
 * keys reuses another row's component state, and here each row has buttons that write to the
 * database.
 */
export function claveDeFila(clave: string, fila: Record<string, unknown>, indice: number): string {
  const campos = IDENTIDAD[clave] ?? [];
  const partes = campos.map((campo) => texto(fila, campo)).filter((parte) => parte !== undefined);
  return partes.length === campos.length && partes.length > 0 ? partes.join('/') : `fila-${String(indice)}`;
}

function texto(fila: Record<string, unknown>, campo: string): string | undefined {
  const valor = fila[campo];
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined;
}

/**
 * What the operator can change in a row WITHOUT leaving the table.
 *
 * Booleans —`enabled` and the three permissions of an edge— are no longer buttons: they are
 * switches, and their logic lives in `interruptores.ts`. What remains here is what is not a boolean
 * and so is not a switch: the ROLE of a membership, a choice between several values, which is what
 * the `<select>` of its own column is for.
 */

export interface AccionDeRol {
  /** Stable inside the row: identifies which change is awaiting confirmation. */
  id: string;
  /** Full phrase; serves as the header of the confirmation and of the outcome notice. */
  descripcion: string;
  mutation: ConfigMutation;
}

/** Same as `AliasSchema`/role in `packages/protocol/src/schemas.ts`. */
const ROL = /^[a-z][a-z0-9_-]{0,63}$/;

/** Fields without which the membership whose role is being changed cannot be identified. */
const IDENTIDAD_MEMBERSHIP = ['tenant_id', 'room_id', 'alias'] as const;

/**
 * Why this row's role CANNOT be changed, or `undefined` if it can.
 *
 * It exists because the selector called `accionDeRol`, got `undefined`, and swallowed the click
 * silently: the operator picked "operator", nothing happened, and nothing on screen explained why.
 * A control that cannot do its job switches itself off and SAYS why; staying silent is
 * indistinguishable from being broken.
 */
export function motivoSinCambioDeRol(fila: Record<string, unknown>): string | undefined {
  const faltan = IDENTIDAD_MEMBERSHIP.filter((campo) => texto(fila, campo) === undefined);
  if (!faltan.length) return undefined;
  return `UNKNOWN: el servidor no publica ${faltan.join(', ')} en esta fila, así que no se puede `
    + 'armar la mutación de rol. Cambialo por el editor de mutaciones JSON.';
}

/**
 * Role change of a membership. Returns `undefined` when the requested role fails the same regex as
 * the gateway's zod, or matches what the row already has: sending one the server will reject —or
 * that changes nothing but still spends a revision— is not an action.
 */
export function accionDeRol(fila: Record<string, unknown>, rol: string): AccionDeRol | undefined {
  const tenantId = texto(fila, 'tenant_id');
  const roomId = texto(fila, 'room_id');
  const alias = texto(fila, 'alias');
  const actual = texto(fila, 'role');
  const pedido = rol.trim();
  if (tenantId === undefined || roomId === undefined || alias === undefined) return undefined;
  if (!ROL.test(pedido) || pedido === actual) return undefined;
  return {
    id: 'role',
    descripcion: `Cambiar el rol de permisos de ${tenantId}/${roomId}/${alias} de ${actual ?? 'UNKNOWN'} a ${pedido}`,
    mutation: {
      resource: 'membership', action: 'update', tenant_id: tenantId, room_id: roomId, alias,
      value: { role: pedido },
    },
  };
}

/**
 * Roles offered in the selector: those in `role_policies` —the only ones the `assertControl` JOIN
 * can resolve— plus the one the row already has, even if it became orphaned. Hiding the current
 * role would make the selector lie about what the row says.
 */
export function rolesDisponibles(
  politicas: readonly Record<string, unknown>[] | undefined,
  rolActual: string | undefined,
): string[] {
  const roles = (politicas ?? [])
    .map((fila) => texto(fila, 'role'))
    .filter((rol): rol is string => rol !== undefined);
  if (rolActual !== undefined && !roles.includes(rolActual)) roles.push(rolActual);
  return [...new Set(roles)].sort((izquierda, derecha) => izquierda.localeCompare(derecha));
}
