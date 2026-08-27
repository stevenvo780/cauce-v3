import { ROLE_BRIEF_MAX, contarRoleBrief } from '../live/role-brief';

/**
 * Catálogo y agrupación de roles de agente derivados del rol declarado en la configuración.
 */

export interface AliasConRol {
  tenantId: string;
  alias: string;
  displayName?: string;
}

export interface RolCatalogado {
  /** Clave estable para React y para comparar: el texto ya recortado. */
  texto: string;
  /** Puntos de código: lo que mide `char_length` en Postgres y el CHECK de la columna. */
  puntos: number;
  /** Unidades UTF-16: lo que mide `z.string().max()` en el adaptador que corre hoy. */
  utf16: number;
  /** `true` si se pasa del tope en CUALQUIERA de las dos unidades. */
  pasado: boolean;
  /** Quiénes lo llevan puesto ahora mismo. */
  portadores: AliasConRol[];
}

export interface CatalogoDeRoles {
  roles: RolCatalogado[];
  /** Alias registrados sin rol declarado. `null` y `''` son lo mismo acá: no hay preámbulo. */
  sinRol: AliasConRol[];
  /** Alias del registro, con o sin rol, para poder ofrecer a quién asignarle uno. */
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
 * Agrupa el registro de agentes por rol declarado.
 *
 * El texto se RECORTA antes de agrupar, por la misma razón por la que el contador recorta antes de
 * medir: el store recorta y recién después guarda, así que dos briefs que sólo se diferencian en un
 * salto de línea final son literalmente el mismo rol para el servidor. Agruparlos aparte mostraría
 * dos roles idénticos y llevaría a «arreglar» una diferencia que no existe.
 */
export function catalogoDeRoles(agentes: readonly Record<string, unknown>[] | null | undefined): CatalogoDeRoles {
  if (!Array.isArray(agentes)) return { roles: [], sinRol: [], todos: [] };
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
  // Los roles más extendidos primero: son los que describen a la flota. Empate por texto para que
  // el orden sea estable entre dos lecturas del mismo snapshot.
  roles.sort((a, b) => b.portadores.length - a.portadores.length || a.texto.localeCompare(b.texto));
  return { roles, sinRol, todos };
}

/**
 * Un nombre corto para reconocer el rol en una lista, sacado de su propio texto.
 *
 * NO es el nombre del rol: es un resumen. Se dice así en pantalla, con esas palabras, porque un
 * título que parece un nombre guardado y no lo es sería la peor de las dos opciones — el operador
 * lo buscaría en la base y no estaría.
 */
export function resumenDeRol(texto: string): string {
  const primeraLinea = texto.split('\n', 1)[0]?.trim() ?? '';
  const base = primeraLinea || texto.trim();
  const puntos = [...base];
  return puntos.length <= 72 ? base : `${puntos.slice(0, 71).join('')}…`;
}
