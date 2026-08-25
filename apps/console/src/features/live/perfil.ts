import type {
  AgentPerfil, AgentPerfilAplicado, AgentPerfilCampos, AgentPerfilValor,
} from '../../api/types';

/**
 * LA LÓGICA DEL EDITOR DE PERFIL, aparte de la pintura para poder probarla sola.
 *
 * ── Qué se está editando ─────────────────────────────────────────────────────────────────────
 *
 * Los SIETE campos autorados del alias (`agent_profiles`, migración 026). Lo que se escribe acá
 * termina, palabra por palabra, dentro del fichero que el arnés de ese alias LEE al arrancar:
 * `CLAUDE.md` para Claude Code, `AGENTS.md` para codex, y los siete Markdown del espacio de
 * trabajo para openclaw —`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, más
 * `MEMORY.md` y `HEARTBEAT.md` que son del agente y no se tocan—.
 *
 * ── Lo que NO se edita acá, y por qué ────────────────────────────────────────────────────────
 *
 * Permisos, cuotas, arnés y alias alcanzables NO son campos: son HECHOS que se leen frescos de
 * `memberships`, `role_policies`, `provider_accounts` y `agents`. Aparecen en la vista previa
 * porque van al fichero, pero no tienen caja. Copiarlos como texto autorado sería una segunda
 * fuente de verdad que se desincroniza en silencio: se revoca un permiso y el fichero del
 * contenedor sigue diciendo que lo tiene.
 *
 * ── La cuenta de unidades ────────────────────────────────────────────────────────────────────
 *
 * Se mide con `max(puntos de código, unidades UTF-16)`, que es lo mismo que miden el CHECK de
 * Postgres y el compilador. No es puntillismo: el 16-ago un alias se quedó SORDO —dejó de recibir
 * entregas, sin un solo error visible— porque dos capas contaban el mismo 1200 en unidades
 * distintas. Una tercera cuenta en el navegador sería el mismo fallo otra vez, sólo que ahora
 * diciéndole al operador que su texto entra cuando no entra.
 */

/** Los campos de texto suelto, en el orden en que se pintan. */
export const CAMPOS_DE_TEXTO = ['purpose', 'role_summary', 'human_brief'] as const;

/** Los campos de lista, en el orden en que se pintan. */
export const CAMPOS_DE_LISTA = ['responsibilities', 'restrictions', 'tools', 'operating_rules'] as const;

export type CampoDeTexto = (typeof CAMPOS_DE_TEXTO)[number];
export type CampoDeLista = (typeof CAMPOS_DE_LISTA)[number];

/**
 * Cómo se llama cada campo en pantalla, y qué se espera que ponga el operador ahí.
 *
 * La ayuda no es decoración: los nombres de columna están en inglés porque el esquema lo está, y
 * `operating_rules` no le dice a nadie qué escribir. Sin esto el operador rellena `purpose` con lo
 * que debería ir en `role_summary` y el `SOUL.md` de openclaw acaba hablando de tareas — que es
 * exactamente cómo se le enseña a un modelo que su identidad son sus tareas.
 */
export const ETIQUETAS: Record<CampoDeTexto | CampoDeLista, { titulo: string; ayuda: string; destino: string }> = {
  purpose: {
    titulo: 'Identidad y propósito',
    ayuda: 'Quién es este alias y para qué existe. No sus tareas: su razón de ser.',
    destino: 'SOUL.md en openclaw',
  },
  role_summary: {
    titulo: 'Rol declarado',
    ayuda: 'Qué papel ocupa en la flota. Sucede al viejo role_brief, con sitio para el detalle que allá no cabía.',
    destino: 'IDENTITY.md en openclaw',
  },
  human_brief: {
    titulo: 'Tu humano y cómo tratarlo',
    ayuda: 'Quién es la persona con la que trata y cómo quiere que le hablen.',
    destino: 'USER.md en openclaw',
  },
  responsibilities: {
    titulo: 'Responsabilidades',
    ayuda: 'Qué le toca hacer. Una por línea.',
    destino: 'AGENTS.md en openclaw',
  },
  restrictions: {
    titulo: 'Restricciones',
    ayuda: 'Qué NO puede hacer, aunque pudiera. Una por línea.',
    destino: 'AGENTS.md en openclaw',
  },
  tools: {
    titulo: 'Herramientas',
    ayuda: 'Con qué cuenta, más allá de las capacidades del arnés. Una por línea.',
    destino: 'TOOLS.md en openclaw',
  },
  operating_rules: {
    titulo: 'Instrucciones fijas de funcionamiento',
    ayuda: 'Cómo se trabaja acá. Lo que hoy se reinyecta en cada mensaje y debería estar escrito una sola vez.',
    destino: 'AGENTS.md en openclaw',
  },
};

/**
 * La cuenta que MANDA: la más estricta de las dos unidades.
 *
 * Es la misma aritmética que `measureStrictestUnits` de `@cauce/protocol`. Se reimplementa acá y no
 * se importa porque la consola es un bundle de navegador y `@cauce/protocol` arrastra `zod` entero;
 * `perfil.test.ts` comprueba que las dos dan el MISMO número sobre los casos que separan una
 * unidad de la otra (acentos y emojis fuera del BMP), que es lo que impide que se separen.
 */
export function contarUnidades(texto: string): number {
  return Math.max([...texto].length, texto.length);
}

/** Lo que el operador tiene delante: el perfil guardado con el borrador encima si lo hay. */
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

/** Una lista se edita como texto, una entrada por línea. Las líneas en blanco no son entradas. */
export function lineasALista(texto: string): string[] {
  return texto.split('\n').map((linea) => linea.trim()).filter((linea) => linea.length > 0);
}

export function listaALineas(items: readonly string[]): string {
  return items.join('\n');
}

/** ¿Cambió algo respecto de lo guardado? Compara valor a valor, no por identidad de objeto. */
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
 * Lo que mide el perfil entero, con el mismo criterio que el techo de la migración 026.
 *
 * Suma los textos y TODAS las entradas de todas las listas. Un campo dentro de su tope no dice
 * nada del total: cuatro listas llenas dan 256.000 unidades con cada campo «dentro del suyo», y el
 * que se queda fuera es el fichero del agente.
 */
export function unidadesDelPerfil(campos: AgentPerfilCampos): number {
  let total = 0;
  for (const campo of CAMPOS_DE_TEXTO) total += contarUnidades(campos[campo]);
  for (const campo of CAMPOS_DE_LISTA) {
    for (const item of campos[campo]) total += contarUnidades(item);
  }
  return total;
}

/** Qué campos se pasan de su tope, con el número medido. Vacío = todo entra. */
export function camposQueNoEntran(
  campos: AgentPerfilCampos,
  limites: AgentPerfil['limites'] | undefined,
): Array<{ campo: string; medido: number; tope: number }> {
  if (limites === undefined) return [];
  const fuera: Array<{ campo: string; medido: number; tope: number }> = [];

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

/** Cuerpo canónico de la ruta aplicada; no contiene identidad ni acción controladas por el cliente. */
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
 * Un 2xx sólo acredita aplicación si converge la misma revisión y trae exactamente un ACK válido
 * por cada fichero esperado. Se valida en runtime porque el JSON remoto no conoce los tipos TS.
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
  for (const rawAck of record.acknowledgements) {
    if (rawAck === null || typeof rawAck !== 'object' || Array.isArray(rawAck)) return false;
    const ack = rawAck as Record<string, unknown>;
    if (typeof ack.name !== 'string' || !pendientes.delete(ack.name)
      || typeof ack.path !== 'string' || !ack.path.startsWith('/')
      || !ack.path.endsWith(`/${ack.name}`)
      || !['written', 'already_current', 'preserved'].includes(String(ack.state))
      || typeof ack.sha !== 'string' || !SHA256.test(ack.sha)
      || typeof ack.bytes !== 'number' || !Number.isSafeInteger(ack.bytes) || ack.bytes < 0) {
      return false;
    }
  }
  return pendientes.size === 0;
}

/**
 * ¿Este perfil ya existe como fila, o sería un alta?
 *
 * La diferencia importa para el DESHACER: un alta se deshace borrando y una edición reponiendo lo
 * de antes. Si un alta se deshiciera con un `update` al perfil vacío quedaría una fila con todo en
 * NULL, que NO es lo mismo que no tener perfil — el compilador distingue «no declarado» de
 * «declarado vacío», y una fila fantasma le haría emitir un bloque donde no debería haber ninguno.
 */
export function perfilYaExiste(perfil: AgentPerfil | undefined): boolean {
  if (perfil === undefined) return false;
  const p = perfil.perfil;
  return p.purpose !== null || p.role_summary !== null || p.human_brief !== null
    || p.responsibilities.length > 0 || p.restrictions.length > 0
    || p.tools.length > 0 || p.operating_rules.length > 0;
}
