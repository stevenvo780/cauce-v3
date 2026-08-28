import type {
  AgentPerfil, AgentPerfilAplicado, AgentPerfilCampos, AgentPerfilValor,
} from '../../api/types';

/**
 * LA LÓGICA DEL EDITOR DE PERFIL, aparte de la pintura para poder probarla sola.
 *
 * Los SIETE campos autorados del alias (`agent_profiles`, migración 026) terminan, palabra por
 * palabra, dentro de los ficheros que LEE el arnés de ese alias. Qué fichero recibe cada campo NO
 * es fijo: lo decide `ficherosDelArnes` de `@cauce/protocol` según el arnés, y `destinosDelArnes`
 * reproduce acá ese reparto para poder rotularlo. `perfil.test.ts` ata la tabla contra la función
 * real de composición, que es lo que impide que se separen.
 *
 * Permisos, cuotas, arnés y alias alcanzables NO son campos: son HECHOS que se leen frescos de
 * `memberships`, `role_policies`, `provider_accounts` y `agents`. Aparecen en la vista previa
 * porque van al fichero, pero no tienen caja. Copiarlos como texto autorado sería una segunda
 * fuente de verdad que se desincroniza en silencio: se revoca un permiso y el fichero del
 * contenedor sigue diciendo que lo tiene.
 *
 * La cuenta de unidades se mide con `max(puntos de código, unidades UTF-16)`, que es lo mismo que
 * miden el CHECK de Postgres y el compilador.
 */

/** Los campos de texto suelto, en el orden en que se pintan. */
export const CAMPOS_DE_TEXTO = ['purpose', 'role_summary', 'human_brief'] as const;

/** Los campos de lista, en el orden en que se pintan. */
export const CAMPOS_DE_LISTA = ['responsibilities', 'restrictions', 'tools', 'operating_rules'] as const;

export type CampoDeTexto = (typeof CAMPOS_DE_TEXTO)[number];
export type CampoDeLista = (typeof CAMPOS_DE_LISTA)[number];
export type CampoDelPerfil = CampoDeTexto | CampoDeLista;

export const CAMPOS_DEL_PERFIL: readonly CampoDelPerfil[] = [
  ...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA,
];

/**
 * Cómo se llama cada campo en pantalla, y qué se espera que ponga el operador ahí.
 *
 * La ayuda no es decoración: los nombres de columna están en inglés porque el esquema lo está, y
 * `operating_rules` no le dice a nadie qué escribir. Sin esto el operador rellena `purpose` con lo
 * que debería ir en `role_summary` y el `SOUL.md` de openclaw acaba hablando de tareas — que es
 * exactamente cómo se le enseña a un modelo que su identidad son sus tareas.
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

/** Dónde acaba un campo: un fichero con nombre, o una ausencia con la palabra que le toca. */
export type DestinoDelCampo =
  | { readonly tipo: 'fichero'; readonly nombre: string }
  | { readonly tipo: 'ausente'; readonly ausente: 'sin-dato' | 'no-aplica'; readonly motivo: string };

/** El único arnés que reparte los campos en varios ficheros; claude y codex los juntan en uno. */
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
 * A qué fichero va cada campo EN ESTE alias, con el arnés que el servidor declara.
 *
 * Sólo se afirma un destino si el arnés es de los que Cauce sabe componer Y el gateway publica ese
 * fichero entre los suyos: rotular `SOUL.md` sobre una respuesta que no lo trae sería prometer una
 * escritura que nadie va a acreditar. Un arnés que no sea claude, codex u openclaw no recibe
 * NINGÚN fichero —`nombresDelArnes` devuelve vacío—, y eso se dice, no se sustituye por openclaw.
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

/** El motivo común cuando NINGÚN campo tiene destino; `undefined` en cuanto uno lo tenga. */
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
 * La cuenta que MANDA: la más estricta de las dos unidades. Misma aritmética que
 * `measureStrictestUnits` de `@cauce/protocol`, reimplementada porque la consola es un bundle de
 * navegador y `@cauce/protocol` arrastra `zod` entero; `perfil.test.ts` comprueba que las dos dan
 * el MISMO número sobre los casos que separan una unidad de la otra (acentos y emojis del BMP).
 */
export function contarUnidades(texto: string): number {
  return Math.max(Array.from(texto).length, texto.length);
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
 * Lo que mide el perfil entero, con el mismo criterio que el techo de la migración 026: suma los
 * textos y TODAS las entradas de todas las listas. Un campo dentro de su tope no dice nada del
 * total: cuatro listas llenas dan 256.000 unidades con cada campo «dentro del suyo».
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
