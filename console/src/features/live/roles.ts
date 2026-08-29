import { ROLE_BRIEF_MAX, contarRoleBrief } from './role-brief';

export interface AliasConRol {
  tenantId: string;
  alias: string;
  displayName?: string;
}

export interface RolCatalogado {
  texto: string;
  /** Puntos de código: lo que mide `char_length` en Postgres y el CHECK de la columna. */
  puntos: number;
  /** Unidades UTF-16: lo que mide `z.string().max()` en el adaptador que corre hoy. */
  utf16: number;
  /** `true` si se pasa del tope en CUALQUIERA de las dos unidades. */
  pasado: boolean;
  portadores: AliasConRol[];
}

export interface CatalogoDeRoles {
  roles: RolCatalogado[];
  /** Alias registrados sin rol declarado. `null` y `''` son lo mismo acá: no hay preámbulo. */
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
 * Agrupa el registro por rol declarado, RECORTANDO el texto antes: el store recorta y recién
 * después guarda, así que dos briefs que sólo difieren en un salto de línea final son el mismo rol.
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
  // Los más extendidos primero; empate por texto para que el orden sea estable entre dos lecturas.
  roles.sort((a, b) => b.portadores.length - a.portadores.length || a.texto.localeCompare(b.texto));
  return { roles, sinRol, todos };
}

/**
 * Nombre corto para reconocer el rol en una lista, sacado de su propio texto. NO es un nombre
 * guardado —en pantalla se dice así—: buscarlo en la base no daría nada.
 */
export function resumenDeRol(texto: string): string {
  const primeraLinea = texto.split('\n', 1)[0]?.trim() ?? '';
  const base = primeraLinea || texto.trim();
  const puntos = Array.from(base);
  return puntos.length <= 72 ? base : `${puntos.slice(0, 71).join('')}…`;
}
