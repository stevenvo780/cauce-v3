import { ROLE_BRIEF_MAX, contarRoleBrief } from './role-brief';

interface AliasConRol {
  tenantId: string;
  alias: string;
  displayName?: string;
}

interface RolCatalogado {
  texto: string;
  /** Code points: what `char_length` measures in Postgres and the column's CHECK. */
  puntos: number;
  /** UTF-16 units: what `z.string().max()` measures in the adapter running today. */
  utf16: number;
  /** `true` if it exceeds the cap in EITHER unit. */
  pasado: boolean;
  portadores: AliasConRol[];
}

interface CatalogoDeRoles {
  roles: RolCatalogado[];
  /** Registered aliases with no declared role. `null` and `''` are the same here: no preamble. */
  sinRol: AliasConRol[];
  todos: AliasConRol[];
}

function aliasDeFila(fila: Record<string, unknown>): AliasConRol | undefined {
  const tenantId = fila.tenant_id;
  const alias = fila.alias;
  if (typeof tenantId !== 'string' || !tenantId) return undefined;
  if (typeof alias !== 'string' || !alias) return undefined;
  const displayName = typeof fila.display_name === 'string' && fila.display_name ? fila.display_name : undefined;
  return { tenantId, alias, ...(displayName ? { displayName } : {}) };
}

export function claveDeAlias(entrada: AliasConRol): string {
  return `${entrada.tenantId}/${entrada.alias}`;
}

/**
 * Groups the registry by declared role, TRIMMING the text first: the store trims and only
 * then persists, so two briefs that differ only in a trailing newline are the same role.
 */
export function catalogoDeRoles(agentes: readonly Record<string, unknown>[] | null | undefined): CatalogoDeRoles {
  if (!agentes) return { roles: [], sinRol: [], todos: [] };
  const porTexto = new Map<string, AliasConRol[]>();
  const sinRol: AliasConRol[] = [];
  const todos: AliasConRol[] = [];
  for (const fila of agentes) {
    const entrada = aliasDeFila(fila);
    if (!entrada) continue;
    todos.push(entrada);
    const bruto = typeof fila.role_brief === 'string' ? fila.role_brief.trim() : '';
    if (!bruto) {
      sinRol.push(entrada);
      continue;
    }
    const lista = porTexto.get(bruto);
    if (lista) lista.push(entrada);
    else porTexto.set(bruto, [entrada]);
  }
  const roles = [...porTexto.entries()].map(([texto, portadores]) => {
    const puntos = contarRoleBrief(texto);
    const utf16 = texto.length;
    return { texto, puntos, utf16, pasado: puntos > ROLE_BRIEF_MAX || utf16 > ROLE_BRIEF_MAX, portadores };
  });
  // Widest first; tie-break by text so the order is stable across two reads.
  roles.sort((a, b) => b.portadores.length - a.portadores.length || a.texto.localeCompare(b.texto));
  return { roles, sinRol, todos };
}

/**
 * Short name to recognize the role in a list, taken from its own text. NOT a stored name
 * —it's only what the UI calls it—: searching for it in the database would return nothing.
 */
export function resumenDeRol(texto: string): string {
  const primeraLinea = texto.split('\n', 1)[0]?.trim() ?? '';
  const base = primeraLinea || texto.trim();
  const puntos = Array.from(base);
  return puntos.length <= 72 ? base : `${puntos.slice(0, 71).join('')}…`;
}
