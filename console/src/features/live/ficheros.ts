import type {
  AgentDocumentGuardado, AgentDocumentItem, AgentDocumentsMap,
} from '../../api/types';

/**
 * LA LÓGICA DE «QUÉ SE PUEDE HACER CON ESTE FICHERO Y POR QUÉ NO».
 *
 * Fuera del componente por lo mismo que `directiva.ts` y `role-brief.ts`: exportar funciones desde
 * un fichero de componentes rompe el fast refresh de Vite y el lint corre con `--max-warnings 0`.
 * Y porque la regla que decide si un documento se ofrece editable tiene que poder probarse sola.
 *
 * Todo lo de aquí existe para una sola cosa: que la pantalla nunca diga «no disponible» a secas.
 * Hay CUATRO motivos distintos por los que un fichero puede no dejarse tocar, y confundirlos es lo
 * que convierte esta vista en un adorno:
 *
 *   1. El gateway no publica la ruta            → no se miró. Se arregla desplegando.
 *   2. La ruta no está MEDIDA en el contenedor  → la ruta no es de fiar. Se arregla midiendo.
 *   3. No hay canal hasta el disco del agente   → falta una pieza que aún no existe.
 *   4. El fichero mezcla credenciales           → NO se va a poder nunca por esta vía, y bien.
 *
 * Los cuatro se parecen en pantalla y significan cosas opuestas. El 4 es una decisión; el 1 es un
 * despliegue pendiente. Pintarlos igual haría que Steven esperara a que «se arregle» algo que
 * está bien como está, o que diera por perdido algo que sólo hay que desplegar.
 */

export type ModoDocumento = 'entero' | 'proyectado' | 'solo-lectura';

/**
 * Qué se puede hacer con un documento.
 *
 * `proyectado` es el caso de `openclaw.json`: el fichero entero NO sale nunca —lleva `auth` y
 * `secrets`— pero unos campos suyos sí. No es «editable a medias»: es un documento distinto, el
 * que se ve, y hay que decirlo con esas palabras antes de que alguien crea que está mirando el
 * fichero completo y borre lo que no ve.
 */
export function modoDeDocumento(item: AgentDocumentItem): ModoDocumento {
  if (item.editable) return 'entero';
  if ((item.projected_fields?.length ?? 0) > 0) return 'proyectado';
  return 'solo-lectura';
}

export interface Explicacion {
  titulo: string;
  detalle: string;
  /** `true` si esto se arregla con un despliegue o una medición; `false` si es una decisión. */
  pendiente: boolean;
}

/**
 * Traduce el fallo del servidor a algo que se pueda leer y, sobre todo, ACTUAR.
 *
 * El `detalle` del servidor se enseña TAL CUAL cuando viene, en vez de reescribirlo: esos
 * mensajes están redactados en el gateway con la razón medida (por qué `skills` no se sirve, por
 * qué no hay canal), y volver a redactarlos aquí sería tener la explicación en dos sitios que
 * pueden divergir. Lo que se añade es el titular y si hay algo que hacer.
 */
export function explicarFallo(status: number | undefined, mensajeServidor?: string): Explicacion {
  const detalle = mensajeServidor?.trim();
  switch (status) {
    case 409:
      return {
        titulo: 'La ruta de este fichero no está medida',
        detalle: detalle ??
          'Nadie ha mirado todavía dentro del contenedor de este agente qué arnés corre ni con ' +
          'qué HOME. Sin esa medición la ruta sería una suposición, y el registro se equivoca de ' +
          'arnés en 5 de los 14 alias.',
        pendiente: true,
      };
    case 503:
      return {
        titulo: 'Todavía no hay camino hasta el disco de este agente',
        detalle: detalle ??
          'La consola no tiene forma de leer ni escribir ficheros dentro del contenedor. Falta ' +
          'esa pieza; no es que este fichero esté vacío.',
        pendiente: true,
      };
    case 403:
      return {
        titulo: 'Este fichero no se sirve por esta vía',
        detalle: detalle ?? 'Mezcla configuración con credenciales.',
        pendiente: false,
      };
    case 413:
      return {
        titulo: 'El fichero pasa del tope',
        detalle: detalle ?? 'Es demasiado grande para editarlo desde aquí.',
        pendiente: false,
      };
    case 404:
      return {
        titulo: 'Este agente no tiene ese documento',
        detalle: detalle ?? 'El arnés que corre no usa ese fichero.',
        pendiente: false,
      };
    default:
      return {
        titulo: 'No se pudo leer el fichero',
        detalle: detalle ?? 'El servidor no dio una razón.',
        pendiente: true,
      };
  }
}

/**
 * El aviso de cabecera cuando las rutas NO están medidas.
 *
 * Devuelve el `caveat` del servidor si viene. Nunca inventa uno: si el gateway dice que la fuente
 * es `measured`, no hay nada que advertir y devolver un aviso genérico «por si acaso» sería un
 * guardia que grita en falso, que es como se acaba ignorando el aviso que sí importa.
 */
export function avisoDeFuente(mapa: AgentDocumentsMap): string | undefined {
  if (!mapa.publicado) return mapa.motivo;
  if (mapa.facts_source === 'measured') return undefined;
  return mapa.caveat;
}

/**
 * El aviso que hay que enseñar ANTES de dejar guardar, no después.
 *
 * Dos casos y los dos son de los que se lamentan luego: un `settings.json` puede llevar `hooks`,
 * que son órdenes de shell que el arnés ejecuta solo —editarlo desde una web es ejecutar código
 * dentro del contenedor—; y un documento proyectado enseña una parte del fichero, así que borrar
 * de la vista borra del documento.
 */
export function avisoAntesDeGuardar(item: AgentDocumentItem): string | undefined {
  if (item.warning) return item.warning;
  if (modoDeDocumento(item) === 'proyectado') {
    return 'De este fichero sólo ves una parte. Lo que quites de aquí se quita del documento.';
  }
  return undefined;
}

/** ¿Hay algo sin guardar? Comparación exacta: un espacio al final también es un cambio. */
export function hayCambios(original: string, borrador: string): boolean {
  return original !== borrador;
}

/**
 * Un 2xx aislado no significa «aplicado». Sólo el contrato nuevo, que trae el ACK de la sonda que
 * escribió en el contenedor, habilita esa palabra. La rama defensiva evita mentir durante un
 * despliegue escalonado si un gateway viejo devuelve la forma anterior.
 */
export function mensajeDeGuardado(resultado: AgentDocumentGuardado): string {
  if (esAckAplicado(resultado)) {
    return `Aplicado en ${resultado.path}: la sonda confirmó el ACK de escritura (${resultado.bytes} bytes).`;
  }
  return `El gateway respondió 2xx, pero la aplicación no quedó confirmada por un ACK completo.`;
}

export interface AckAplicado {
  readonly ok: true;
  readonly state: 'applied';
  readonly evidence: 'probe_write_ack';
  readonly path: string;
  readonly sha: string;
  readonly bytes: number;
}

/** Sólo esta forma completa autoriza a limpiar el borrador visible. */
export function esAckAplicado(resultado: AgentDocumentGuardado): resultado is AckAplicado {
  return resultado.ok === true
    && resultado.state === 'applied'
    && resultado.evidence === 'probe_write_ack'
    && typeof resultado.path === 'string' && resultado.path.startsWith('/')
    && typeof resultado.sha === 'string' && /^[0-9a-f]{64}$/.test(resultado.sha)
    && typeof resultado.bytes === 'number' && Number.isSafeInteger(resultado.bytes)
    && resultado.bytes >= 0;
}
