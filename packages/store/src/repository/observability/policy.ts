import { MAX_MESSAGE_TIMEOUT_MS, messageTimeoutMs } from '@cauce/protocol';
import { StoreError } from '../quotas.js';

/** Techo de vida total de un intento de entrega cuando el mensaje no declara `body.timeout_ms`. */
export const DEFAULT_DELIVERY_LEASE_CAP_MS = 12 * 60 * 60_000;

/** Margen adicional sobre `body.timeout_ms` para cubrir esperas de sesión y entrega de ACK. */
export const DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS = 30 * 60_000;

/** Tiempo máximo de estacionamiento para entregas dirigidas a alias sin adaptadores conectados. */
export const DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS = 24 * 60 * 60_000;

/** Techo de vida de una entrega. Ver `DEFAULT_DELIVERY_LEASE_CAP_MS`. */
export interface DeliveryLeaseCap {
  /** Techo por defecto, para mensajes sin `body.timeout_ms`. */
  readonly leaseCapMs?: number;
  /** Margen sumado al `body.timeout_ms` declarado. */
  readonly leaseCapGraceMs?: number;
}

export function positiveMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StoreError('conflict', `${name} must be a positive integer`);
  }
  return value;
}

/**
 * Techo de vida de ESTA entrega: `body.timeout_ms + gracia` si el mensaje lo declara, y el
 * default configurado si no.
 *
 * Un `timeout_ms` declarado gana en las DOS direcciones, y eso es a propósito. Hacia arriba
 * porque es la única forma de pedir un turno de más de 12 h sin tocar la configuración de la
 * flota entera. Hacia abajo porque un publicador que sabe que su tarea dura 5 minutos puede
 * pedir supervisión estrecha, y con `timeout_ms=300000` el techo queda en 35 min en vez de 12 h.
 */
export function deliveryLeaseCapMs(
  body: Record<string, unknown> | undefined,
  cap: DeliveryLeaseCap = {}
): number {
  const fallback = positiveMs(cap.leaseCapMs, DEFAULT_DELIVERY_LEASE_CAP_MS, 'lease cap');
  const grace = positiveMs(cap.leaseCapGraceMs, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, 'lease cap grace');
  const declared = messageTimeoutMs(body);
  return declared === undefined ? fallback : declared + grace;
}

/**
 * Instante en que la garra de una entrega deja de poder renovarse, en SQL.
 *
 * El ancla es `COALESCE(execution_started_at, claimed_at)`, o sea la MÁS TARDÍA de las dos que
 * conocemos, porque las dos se limpian en cada reintento y por lo tanto miden la vida del
 * INTENTO vigente, no la de la entrega desde que nació. Elegir la más tardía es la opción
 * permisiva: cuando el adaptador informa que el harness arrancó de verdad, el tiempo que la
 * entrega pasó esperando el candado de sesión NO se le descuenta del techo.
 *
 * Con las dos en NULL la expresión da NULL, y tanto `LEAST` como la comparación `<= now()`
 * tratan ese NULL como "no hay techo". También es deliberado: una fila sin `claimed_at` no
 * está en vuelo y no es asunto de este guarda.
 */
export function leaseCapInstantSql(capMsParameter: string, table = 'd'): string {
  return `(COALESCE(${table}.execution_started_at,${table}.claimed_at)`
    + ` + ${capMsParameter}*interval '1 millisecond')`;
}

/**
 * `deliveryLeaseCapMs` en SQL, para el reaper, que necesita el techo dentro del WHERE y no
 * puede traerse la flota entera a memoria para calcularlo fila por fila.
 *
 * Los dos CASE anidados no son estilo: el `::bigint` sólo aparece dentro del THEN del CASE
 * externo, así que PostgreSQL garantiza que el guarda de forma (`jsonb_typeof` + expresión
 * regular) se evaluó ANTES del cast. Con un solo CASE y un AND, el orden de evaluación de los
 * operandos no está definido y una fila vieja con `timeout_ms:"pronto"` reventaría el tick
 * entero del reaper con un error de conversión — exactamente el modo de falla que ya dejó una
 * vez a la flota con los agentes vivos y las entregas muertas.
 *
 * La regla tiene que dar lo MISMO que `messageTimeoutMs`, incluido el máximo de 7 días: si
 * divergieran, el WHERE marcaría una entrega como vencida por techo y el motivo que se escribe
 * en `dead_letters` diría otro número.
 */
export function leaseCapMsSql(defaultCapParameter: string, graceParameter: string, table = 'm'): string {
  return `COALESCE(
    CASE WHEN jsonb_typeof(${table}.body->'timeout_ms')='number'
              AND (${table}.body->>'timeout_ms') ~ '^[1-9][0-9]{0,9}$'
         THEN CASE WHEN (${table}.body->>'timeout_ms')::bigint <= ${MAX_MESSAGE_TIMEOUT_MS}
                   THEN (${table}.body->>'timeout_ms')::bigint + ${graceParameter}::bigint END
    END, ${defaultCapParameter}::bigint)`;
}

/**
 * Retención de los ACK de RENOVACIÓN: 6 h.
 *
 * Un ACK de renovación dice "el harness sigue vivo". Su valor operativo dura lo que dura la
 * entrega, y su valor forense se agota en cuanto la entrega termina: para reconstruir un
 * incidente alcanza con saber cuándo arrancó, cuándo terminó y con qué — no con tener las 1.041
 * pruebas de vida intermedias. 6 h es cómodamente más que el techo típico de una entrega larga
 * en curso, así que ninguna renovación se borra mientras su entrega sigue viva; y cubre además
 * el turno de un operador que llega a investigar algo que pasó "esta mañana".
 */
export const DEFAULT_RETENTION_ACK_RENEWAL_MS = 6 * 60 * 60_000;

/**
 * Retención general de `delivery_acks`: 14 días. Cubre las transiciones de estado (accepted,
 * el primer started, done, failed), que son la prueba de qué hizo el sistema con cada entrega,
 * y también las filas anteriores a la migración 014, que no se pueden reclasificar.
 */
export const DEFAULT_RETENTION_ACK_MS = 14 * 24 * 60 * 60_000;

/** Retención de los `audit_events` de renovación de garra. Mismo argumento que los ACK. */
export const DEFAULT_RETENTION_AUDIT_RENEWAL_MS = 6 * 60 * 60_000;

/**
 * Retención general de `audit_events`: 30 días, MÁS que los ACK, y a propósito. Un ACK es
 * telemetría de transporte; un audit_event contesta "quién autorizó qué, y con qué decisión",
 * que es la pregunta que aparece semanas después.
 */
export const DEFAULT_RETENTION_AUDIT_MS = 30 * 24 * 60 * 60_000;

/**
 * Acciones de `audit_events` que son TELEMETRÍA y por lo tanto se pueden borrar. LISTA BLANCA,
 * no lista negra, y ésta es la decisión más importante de todo el barrido.
 *
 * `audit_events` NO es un log en este sistema: es ESTADO del que dependen guardas de
 * corrección, y borrar por edad a secas los rompería en silencio y con semanas de retraso.
 * Las dos que costarían caro:
 *
 *  - `delivery.replay` (allow) es el candado de idempotencia del replay manual: `replayDelivery`
 *    pregunta si ya existe uno antes de clonar. Sin esa fila, un dead letter que un humano
 *    reencola a los 31 días se clona DOS veces y se paga la corrida dos veces — exactamente el
 *    desperdicio que el resto de este parche existe para cortar. Además es el detector de
 *    ciclos de linaje (`replayed_from_message_id`), así que borrarla también reabre el camino
 *    que el sistema cierra a propósito.
 *  - `agent_output.response` (allow/deny) es la marca de confianza de la cadena agente-a-agente:
 *    `materializeAgentResponse` sólo cree la correlación declarada si existe esa fila, y la
 *    vista de cadena y el fan-in la usan para contar respuestas. Sin ella, la respuesta al padre
 *    se degrada a "no es hija" sin ningún error visible.
 *
 * Por eso la lista arranca con `delivery.ack` y nada más: es la única acción de volumen (una
 * fila por ACK aplicado) que ninguna consulta lee para decidir nada. `delivery.ack_timeout` y
 * `delivery.lease_cap` quedan fuera aunque nadie las lea: son la evidencia de por qué murió una
 * entrega, son raras, y no pesan.
 *
 * NO se expone como variable de entorno a propósito. Una lista de acciones configurable invita
 * a que alguien agregue `delivery.replay` para "ahorrar espacio" y rompa el candado de
 * idempotencia sin que ningún test lo note. Ampliarla es un cambio de código, revisable.
 */
export const DISPOSABLE_AUDIT_ACTIONS: readonly string[] = ['delivery.ack'];

/** Filas por lote y por tabla en cada barrido. Acota el DELETE sobre una base viva. */
export const DEFAULT_RETENTION_BATCH = 5_000;

/** Ventanas de retención de la observabilidad. Ver `pruneObservability`. */
export interface ObservabilityRetentionPolicy {
  readonly ackRenewalMs?: number;
  readonly ackMs?: number;
  readonly auditRenewalMs?: number;
  readonly auditMs?: number;
  readonly batch?: number;
  /** Ver `DISPOSABLE_AUDIT_ACTIONS`. Ampliarla sin leer ese comentario rompe cosas. */
  readonly disposableAuditActions?: readonly string[];
}

/** Filas borradas por cada regla en un barrido. */
export interface ObservabilityRetentionResult {
  readonly ack_renewals: number;
  readonly acks: number;
  readonly audit_renewals: number;
  readonly audit_events: number;
}

/** Política del reaper de garras vencidas. Ver `retryStaleDeliveries`. */
export interface StaleDeliveryPolicy extends DeliveryLeaseCap {
  /**
   * Vuelve al comportamiento viejo: reintentar aunque conste que la entrega ya había arrancado.
   * Existe como palanca de emergencia, no como default. Prenderlo vuelve a pagar cada corrida
   * dos veces.
   *
   * NO desactiva el techo de vida: son dos guardas distintas. Ésta decide qué hacer con una
   * garra vencida que YA se pagó; el techo decide cuándo una garra deja de poder renovarse.
   * Reintentar una entrega que estuvo 12 h renovando es exactamente la realimentación que el
   * techo existe para cortar, así que el techo manda incluso con la palanca prendida.
   */
  readonly retryStartedDeliveries?: boolean;
  /**
   * Apaga el aparcado de entregas cuyo destino no tiene NINGÚN adaptador conectado. Prenderlo
   * (o sea, poner `false`) devuelve el comportamiento viejo: gastar los tres intentos contra un
   * alias que no existe y morir. Existe como palanca, no como default.
   */
  readonly parkWithoutConsumer?: boolean;
  /**
   * Hasta cuándo se aparca una entrega sin consumidor. No es un criterio sobre efectos —de eso
   * se ocupa `execution_started_at`— sino un horizonte de retención: pasado ese tiempo el
   * contexto conversacional ya no existe y sostenerla en cola deja de servirle a nadie.
   * Default: 24 h.
   */
  readonly noConsumerParkMaxAgeMs?: number;
}

/**
 * Espaciado de reintentos por garra vencida: 30 s, 60 s, 120 s… con techo de 5 minutos.
 *
 * Es distinto (y más largo) que el backoff de un ACK 'failed' retryable, que arranca en 1 s y
 * llega a 60 s. La asimetría es deliberada: un fallo declarado significa que el agente contestó
 * y falló, y reintentar rápido es razonable. Una garra vencida significa lo contrario —el agente
 * no dijo nada durante todo el plazo— y el trabajo agéntico tarda lo que tarda. Volver a
 * ofrecerle la entrega en el tick siguiente, lo que hacía `available_at=now()`, apila una segunda
 * corrida sobre la primera, que puede seguir viva, y es exactamente la realimentación positiva
 * que describe el incidente: cada muerte generaba más carga, que generaba más muertes.
 */
export function timeoutRetryBackoffSeconds(attempt: number): number {
  return Math.min(300, 30 * 2 ** Math.max(0, attempt - 1));
}
