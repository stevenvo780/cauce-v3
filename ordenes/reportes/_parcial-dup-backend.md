# Auditoría de duplicación — backend (`packages/{store,protocol,adapter-sdk,mcp-fleet-monitor}` + `services/{gateway,dispatcher,terminal-relay,telegram-bridge}`)

Sector: 249 ficheros `.ts/.tsx` (excluye `*.test.*`). Detector mecánico (`/tmp/opencode/dup-detector/detect.mjs`): normaliza (elimina `/* … */` y `// …`, colapsa espacios), genera todas las ventanas de N líneas consecutivas no-neutras, agrupa por SHA-1, filtra `≥2 ficheros` y `≥2 ocurrencias`. Probado con N=6 y N=10. Anclaje de bloques por las 3 primeras líneas normalizadas para colapsar solapamientos por sliding-window. Verificación manual lectura de ambos lados de cada candidato.

Total mecánico: 296 bloques anclados distintos. Confirmados a mano: **18**. Descartados: 4 (boilerplate declarado explícito, ver final). Estimación de líneas-físicas duplicadas confirmadas: **~497 línea-ocurrencias** (= Σ ocurrencias × líneas por bloque; ver tabla resumen).

## Grupos confirmados (18)

### G-1 — Parser de `project_doc` del agente Codex (constantes + `validCodexFallbackFilename` + `codexProjectDocumentFields` + validación de runtime facts) — 2 ocurrencias — 41 líneas cada una
- `services/gateway/src/terminal/registry.ts:207-247`
- `services/terminal-relay/src/agent-hello.ts:161-201`

CITA LADO A (`registry.ts:207-223`):
```
const MAX_CODEX_PROJECT_DOC_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_FALLBACKS = 16;
const CODEX_NEVER_SERVE_BASENAMES = new Set([
  '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
  'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
]);
const CODEX_NEVER_SERVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

function validCodexFallbackFilename(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\')
    && !value.includes('..') && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    && !CODEX_NEVER_SERVE_BASENAMES.has(normalized)
    && !CODEX_NEVER_SERVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
```

CITA LADO B (`agent-hello.ts:161-178`):
```
const MAX_CODEX_PROJECT_DOC_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_FALLBACKS = 16;
const CODEX_NEVER_SERVE_BASENAMES = new Set([
  '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
  'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
]);
const CODEX_NEVER_SERVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

function validCodexFallbackFilename(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\')
    && !value.includes('..') && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    && !CODEX_NEVER_SERVE_BASENAMES.has(normalized)
    && !CODEX_NEVER_SERVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
```

A mayores, `codexProjectDocumentFields` (registry.ts:226-247 y agent-hello.ts:180-201) tiene cuerpo byte-idéntico: misma guarda `harness !== 'codex' || typeof maxBytes !== 'number' || ...`, mismo `seen = new Set<string>(['AGENTS.override.md', 'AGENTS.md'])`, mismo `return { project_doc_max_bytes: maxBytes, project_doc_fallback_filenames: fallbacks }`. Las firmas sólo en el nombre del parámetro (`record` vs `source`) y el genérico devuelto (`Pick<AgentPresence, ...>` vs `Pick<AgentHello, ...>`). El bloque adyacente — `workspacePairSafe`/`projectPairSafe`/`contextFieldsSafe`/`runtimeFactsObserved` y el spread con `...(harness === 'codex' ? { codex_home: ... } : {})` — también byte-idéntico (registry.ts:271-312 vs agent-hello.ts:272-316).

HOGAR ÚNICO SUGERIDO: `packages/protocol/src/agent-codex-project-doc.ts` (nuevo) exportando `MAX_CODEX_PROJECT_DOC_BYTES`, `MAX_CODEX_FALLBACKS`, `CODEX_NEVER_SERVE_BASENAMES`, `CODEX_NEVER_SERVE_SUFFIXES`, `validCodexFallbackFilename`, `codexProjectDocumentFields(record: Record<string, unknown>, harness: string)`. Dueño del paquete `protocol`: Codex.

RIESGO: **medio**. Las dos copias no han DIVERGIDO todavía en el cuerpo de la función (verificado byte-a-byte), pero `agent-hello.ts:129` ya exporta su propio `stringField` (G-18) mientras registry.ts tiene el suyo distinto — el mismo equipo está copiando-y-pegando entre estos dos archivos. Un cambio futuro (p. ej. añadir un basename prohibido o cambiar el cap) requerirá tocar los dos sitios a la vez.

### G-2 — Creación de `TerminalAuditContext` desde una `row` con política — 5 ocurrencias — 9 líneas cada una
- `services/gateway/src/terminal/relay-proxy/consume.ts:90-99`
- `services/gateway/src/terminal/relay-proxy/resume.ts:95-104`
- `services/gateway/src/terminal/relay-proxy/close.ts:67-76` (auditoría `session.close`)
- `services/gateway/src/terminal/session-control.ts:380-389` (`session.attributed_grant`)
- `services/gateway/src/terminal/session-control.ts:767-776` (`session.owner_rotated`)

CITA LADO A (`consume.ts:90-99`):
```
const actor = sessionActor(row);
const context: TerminalAuditContext = {
  operator_id: row.operator_id,
  attributed: row.attributed,
  target_tenant: row.tenant_id,
  target_alias: row.alias,
  container: row.container,
  cohort: policy.cohort === undefined ? [] : cohortLabels(policy.cohort),
  mode: row.mode,
};
```

CITA LADO B (`resume.ts:95-104`): idéntico byte-a-byte al LADO A.

Diferencias entre las 5: el origen de `policy.cohort` varía: `consume.ts` y `resume.ts` lo calculan con `currentSessionPolicy(row, true, client)`; `close.ts` y `session-control.ts:767` lo reciben ya resuelto (a veces con `cohort: []` literal). El campo `cohort` es, por tanto, **divergente** entre sitios.

HOGAR ÚNICO SUGERIDO: `services/gateway/src/terminal/audit.ts` exportando `terminalAuditContextFromRow(row: TerminalSessionRow, policy: SessionPolicy): TerminalAuditContext`. Dueño de `services/gateway`: Codex.

RIESGO: **medio**. El campo `cohort` ya DIVERGE entre los 5 sitios (`cohort: []` literal vs `cohort: policy.cohort === undefined ? [] : cohortLabels(policy.cohort)`). Si el contrato exige siempre `cohortLabels`, los sitios con literal rompen auditoría.

### G-3 — Envoltorio `BEGIN; ... ; COMMIT / ROLLBACK / finally release` — 4 ocurrencias — 10 líneas cada una
- `services/gateway/src/terminal/relay-proxy/authorization.ts:126-133`
- `services/gateway/src/terminal/relay-proxy/close.ts:136-143`
- `services/gateway/src/terminal/relay-proxy/consume.ts:265-272`
- `services/gateway/src/terminal/relay-proxy/resume.ts:206-213`

CITA LADO A (`consume.ts:265-272`):
```
await client.query('COMMIT');
transactionOpen = false;
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
}
```

CITA LADO B (`resume.ts:206-213`): idéntico byte-a-byte al LADO A.

Preámbulo también idéntico: `const client = await pool.connect(); let transactionOpen = false; ... try { await client.query('BEGIN'); transactionOpen = true; ... }` aparece en los 4 sitios (consume.ts:41-49, resume.ts:55-63, authorization.ts ~33, close.ts ~43).

HOGAR ÚNICO SUGERIDO: helper `withRelayProxyTransaction<T>(pool, work: (client) => Promise<T>): Promise<T>` en `services/gateway/src/terminal/relay-proxy/context.ts` (ya exporta utilidades para los hijos). Dueño: Codex.

RIESGO: **bajo**. Aún no ha divergido.

### G-4 — UPDATE `terminal_sessions` para "claim takeover" (`relay_claim_sha256`+`epoch+1`+LEAST) — 2 ocurrencias — 16 líneas cada una
- `services/gateway/src/terminal/relay-proxy/consume.ts:181-196`
- `services/gateway/src/terminal/relay-proxy/resume.ts:163-178`

CITA LADO A (`consume.ts:181-196`):
```
const takeover = await client.query<ClaimedSession>(
  `UPDATE terminal_sessions
      SET relay_claim_sha256=$2,
          relay_claim_epoch=relay_claim_epoch+1,
          relay_claimed_at=now(),
          relay_instance_id=$5,
          relay_boot_id=$6,
          relay_claim_expires_at=LEAST(
            consumed_at+make_interval(secs => $4),
            now()+make_interval(secs => $3)
          )
    WHERE id=$1 AND consumed_at IS NOT NULL
      AND revoked_at IS NULL AND closed_at IS NULL
      AND consumed_at+make_interval(secs => $4)>now()
      AND (relay_claim_expires_at IS NULL OR relay_claim_expires_at<=now())
      AND relay_claim_epoch<9223372036854775807
    RETURNING *,now() AS database_now`,
```

CITA LADO B (`resume.ts:163-178`): idéntico byte-a-byte al LADO A.

Idénticos también los arrays de parámetros (`[sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds, identity.relay_instance_id, identity.relay_boot_id]`) y la asignación posterior (`session = takeover.rows[0]; databaseNow = takeover.rows[0]?.database_now; takenOver = session !== undefined;`).

HOGAR ÚNICO SUGERIDO: helper `takeoverSessionClaim(client, sid, claimSha256, config, identity): Promise<ClaimedSession | undefined>` en `services/gateway/src/terminal/relay-proxy/context.ts`. Dueño: Codex.

RIESGO: **bajo**. La condición `AND relay_claim_epoch<9223372036854775807` (BigInt max) es idéntica; si alguien la cambia en un sitio y no en el otro, las dos rutas de takeover quedan con semántica distinta — bug latente.

### G-5 — SELECT `membership.room_id` con JOINs de `memberships / role_policies / tenants / rooms` (room habilitada del agente) — 5 ocurrencias — 6 líneas cada una
- `packages/store/src/repository/agents/chain-control/materialization.ts:78-84`
- `packages/store/src/repository/agents/chain-control.ts:107-114`
- `packages/store/src/repository/agents/fanin/materialization.ts:229-236`
- `packages/store/src/repository/agents/fanin/response.ts:75-82`
- `packages/store/src/repository/agents/notifications.ts:171-178`

CITA LADO A (`chain-control/materialization.ts:78-84`):
```
`SELECT membership.room_id
 FROM memberships membership
 JOIN role_policies policy ON policy.role=membership.role
 JOIN tenants tenant ON tenant.id=membership.tenant_id
 JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
 WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
   AND tenant.enabled AND room.enabled AND policy.allow_route
```

CITA LADO B (`notifications.ts:171-178`): idéntico byte-a-byte al LADO A en las 6 líneas. (Difiere sólo el cierre: `ORDER BY membership.room_id` o `ORDER BY (membership.room_id=$3) DESC, membership.room_id LIMIT 1`, y la presencia o no de `FOR SHARE OF ...`.)

HOGAR ÚNICO SUGERIDO: `packages/store/src/repository/agents/_routing-room.ts` (nuevo, interno al paquete store) exportando `selectRoutableRoom(client, tenantId: Tenant, alias: string, opts?: { tieBreakRoomId?: string; withShareLock?: boolean }): Promise<{ room_id: string } | undefined>`. Dueño del paquete `store`: Codex.

RIESGO: **medio**. Las cláusulas de cierre (`FOR SHARE`, `ORDER BY ... LIMIT 1` vs sin `LIMIT`, `tieBreakRoomId`) DIFIEREN — copy-paste con drift. Si dos de estos sitios necesitan coherencia transaccional y el resto no, el helper debería aceptar `withShareLock` para no obligar a unificar accidentalmente semánticas distintas.

### G-6 — Validador de timestamp ISO 8601 UTC estricto (regex + Date.parse + round-trip UTC) — 3 ocurrencias — 10 líneas cada una
- `services/gateway/src/console/agent-documents/relay-probe.ts:402-411`
- `services/gateway/src/console/relay-governance-client.ts:93-102`
- `services/terminal-relay/src/governance-read.ts:124-133`

CITA LADO A (`relay-probe.ts:402-411`):
```
const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
if (match === null || Number.isNaN(Date.parse(value))) return false;
const date = new Date(value);
return date.getUTCFullYear() === Number(match[1])
  && date.getUTCMonth() + 1 === Number(match[2])
  && date.getUTCDate() === Number(match[3])
  && date.getUTCHours() === Number(match[4])
  && date.getUTCMinutes() === Number(match[5])
  && date.getUTCSeconds() === Number(match[6]);
}
```

CITA LADO B (`governance-read.ts:124-133`): idéntico byte-a-byte al LADO A.

Diferencias entre los 3: la línea previa (línea 91, 93 y 401 respectivamente) usa una constante de cap de bytes distinta (`MAX_MEMORY_DATE_BYTES`, `MAX_DATE_BYTES`, `MAX_GOVERNANCE_DATE_BYTES`); el resto es idéntico.

HOGAR ÚNICO SUGERIDO: `packages/protocol/src/iso-utc.ts` (nuevo) exportando `isStrictIsoUtc(value: unknown): value is string`. Dueño del paquete `protocol`: Codex.

RIESGO: **bajo**. Sólo diverge el nombre del cap. Si el regex alguna vez cambia (p. ej. admitir `+00:00` además de `Z`), el cambio deberá replicarse en 3 sitios.

### G-7 — INSERT `audit_events` para auditoría transaccional — 2 ocurrencias — 13 líneas cada una
- `services/gateway/src/terminal/audit.ts:31-44` (`recordTerminalAudit`, usa `pool`)
- `services/gateway/src/terminal/plugin.ts:211-227` (`recordTransactionalTerminalAudit`, usa `client`)

CITA LADO A (`audit.ts:31-44`):
```
export async function recordTerminalAudit(pool: DatabasePool, entry: TerminalAuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events(tenant_id, actor_alias, action, decision, trace_id, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      entry.tenant_id,
      entry.actor_alias,
      entry.action,
      entry.decision,
      entry.trace_id ?? null,
      JSON.stringify(entry.metadata)
    ]
  );
}
```

CITA LADO B (`plugin.ts:215-227`): idéntico byte-a-byte salvo que `pool.query` → `client.query` y la coma final del array de parámetros (estilo).

HOGAR ÚNICO SUGERIDO: `services/gateway/src/terminal/audit.ts` debe exportar `recordTerminalAuditOn(executor, entry)` donde `executor: DatabasePool | DatabaseClient`; `plugin.ts` lo importa en lugar de redefinir `recordTransactionalTerminalAudit`. Dueño de `services/gateway`: Codex.

RIESGO: **bajo**.

### G-8 — `replyError` con cascada AuthError / AuthorizationError / fallback — 2 ocurrencias — 12 líneas cada una
- `services/gateway/src/routes/shared.ts:34-49`
- `services/gateway/src/terminal/plugin.ts:92-114`

CITA LADO A (`routes/shared.ts:34-49`):
```
export function replyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof StoreError) {
    void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  void reply.code(400).send({ error: 'invalid_request', message });
}
```

CITA LADO B (`plugin.ts:92-114`): mismas 12 líneas para `AuthError`, `AuthorizationError` y el fallback 400. DIFIERE sólo en `StoreError` (plugin.ts:108 usa `error.code === 'not_found' ? 404 : 403`, no `statusFor(error)`) y la rama extra `TerminalClockSkewError` (plugin.ts:93-99).

HOGAR ÚNICO SUGERIDO: `plugin.ts` debe `import { replyError } from '../routes/shared.js'` y sólo pre-tratar `TerminalClockSkewError` antes de delegar. Dueño: Codex.

RIESGO: **medio**. La rama `StoreError` ya DIVERGE: `routes/shared.ts` usa `statusFor(error)` (404/422/500), `plugin.ts` colapsa todo a `404 o 403`. Una ACK denegada por `not_found` en una ruta del terminal devuelve 403 (gateway) pero 404 (resto). Inconsistencia observable para clientes.

### G-9 — Interfaz `EgressDestinationRow` vs `DestinationRow` (mismo fila de BD, copy-paste divergido) — 2 ocurrencias — 11 líneas solapadas
- `packages/store/src/configuration/mutations.ts:8-25` (`DestinationRow`)
- `packages/store/src/repository/agents/notifications.ts:52-68` (`EgressDestinationRow`)

CITA LADO A (`mutations.ts:8-25`):
```
interface DestinationRow {
  adapter: string;
  channel: string;
  conversation_id: string;
  conversation_kind: 'dm' | 'group';
  display_label: string | null;
  allow_kinds: string[];
  ...
  enabled: boolean;
}
```

CITA LADO B (`notifications.ts:52-68`): los mismos 11 campos finales (`allow_kinds` … `enabled`) están byte-a-byte; **DIFIERE** en `conversation_kind: string` (vs `'dm' | 'group'`) y **OMITE** `display_label`.

El `SELECT` que materializa `EgressDestinationRow` (`notifications.ts:187-189`) tampoco pide `display_label` mientras `destinationColumns` (`mutations.ts:27`) sí lo incluye — divergencia en la lista de columnas.

HOGAR ÚNICO SUGERIDO: `packages/store/src/repository/egress-destinations.ts` (nuevo) exportando `EgressDestinationRow` con `conversation_kind: 'dm' | 'group'` (estrechado) y `display_label: string | null`; `mutations.ts` lo importa y elimina su `DestinationRow`. Si algún consumidor depende del ancho, refactor con `satisfies` o un alias. Dueño del paquete `store`: Codex.

RIESGO: **ALTO**. Ya divergió: `conversation_kind` narrowing y `display_label` faltan en una cara. Una mutación que escribe `'channel'` como `'channel_post'` se acepta silenciosamente al leer desde el path de notificaciones pero rompe al revalidar configuración. Es el caso típico de "el validador y el consumidor no se pusieron de acuerdo".

### G-10 — Clasificador de code-points hostiles (C0/C1 + bidi + invisibles) — 3 ocurrencias — 7 líneas cada una
- `packages/protocol/src/schemas.ts:135-142` (`hasUnsafeAttachmentCodePoint`, privado)
- `services/telegram-bridge/src/artifacts.ts:79-86` (`hasUnsafeCodePoint`, privado)
- `services/telegram-bridge/src/attachments.ts:90-97` (`hasUnsafeAttachmentCodePoint`, **exportado**)

CITA LADO A (`schemas.ts:135-142`):
```
function hasUnsafeAttachmentCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb);
  });
}
```

CITA LADO B (`attachments.ts:90-97`): idéntico byte-a-byte al LADO A (sólo cambia visibilidad a `export`).

El comentario en `attachments.ts:83-89` reconoce explícitamente el riesgo ("dos validadores del mismo campo que se van desincronizando es exactamente cómo un valor termina aceptado por una capa y rechazado por la de al lado") pero no unificó.

HOGAR ÚNICO SUGERIDO: `packages/protocol/src/has-unsafe-codepoint.ts` (nuevo) exportando `hasUnsafeAttachmentCodePoint`; los tres sitios importan. Dueño del paquete `protocol`: Codex.

RIESGO: **medio**. Cuerpo idéntico hoy. Si se añade un code-point al set (p. ej. `0xE0000–0xE007F` tags), el cambio debe replicarse en 3 archivos — y `attachments.ts` ya está documentando que esto es un riesgo conocido.

### G-11 — Derivación de UUID v7 desde un SHA-256 truncado — 4 ocurrencias — 5 líneas cada una
- `packages/store/src/repository/agents/chain-control/policy.ts:88-95` (`agentOutputRequestId`)
- `packages/store/src/repository/agents/fanin/helpers.ts:54-61` (`agentResponseRequestId`)
- `packages/store/src/repository/agents/fanin/helpers.ts:66-72` (`agentFaninRequestId`)
- `packages/store/src/repository/agents/notifications.ts:76-83` (`agentNotifyRequestId`)

CITA LADO A (`policy.ts:88-95`):
```
const bytes = Buffer.from(
  createHash('sha256').update(`agent-output:${deliveryId}:${attempt}:${outputIndex}`).digest('hex').slice(0, 32),
  'hex'
);
bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
const hex = bytes.toString('hex');
return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
```

CITA LADO B (`fanin/helpers.ts:54-61`): idéntico byte-a-byte al LADO A (cambia la cadena pasada a `update()`).

HOGAR ÚNICO SUGERIDO: `packages/store/src/repository/_hash-to-uuidv7.ts` (nuevo, interno al paquete store) exportando `hashToUuidV7(input: string): string`. Dueño del paquete `store`: Codex.

RIESGO: **bajo**. Sólo cambia el `update(...)`. Pero fija una política de versión (bits 6/8 → 0x50/0x80) que debe ser idéntica en los 4 sitios para que la sufijo temporal del UUIDv7 sea consistente — hoy lo es por copy-paste, no por contrato.

### G-12 — `sleep(ms, signal)` con AbortSignal — 2 ocurrencias — 10 líneas cada una
- `services/telegram-bridge/src/egress.ts:265-274`
- `services/telegram-bridge/src/poller.ts:89-98`

CITA LADO A (`egress.ts:265-274`):
```
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
```

CITA LADO B (`poller.ts:89-98`): idéntico byte-a-byte al LADO A.

HOGAR ÚNICO SUGERIDO: `services/telegram-bridge/src/abort-sleep.ts` (nuevo) exportando `sleep`. Dueño de `services/telegram-bridge`: Gemini.

RIESGO: **bajo**.

### G-13 — Sub-SELECT EXISTS sobre `memberships actor_membership / role_policies / tenants / rooms` para autorizar actor — 2 ocurrencias — 13 líneas cada una
- `packages/store/src/repository/config.ts:93-105`
- `services/gateway/src/terminal/relay-proxy/context.ts:285-296`

CITA LADO A (`config.ts:93-101`):
```
AND EXISTS (
  SELECT 1
    FROM memberships actor_membership
    JOIN role_policies actor_role ON actor_role.role=actor_membership.role
    JOIN tenants actor_tenant ON actor_tenant.id=actor_membership.tenant_id
    JOIN rooms actor_room
      ON actor_room.id=actor_membership.room_id
     AND actor_room.tenant_id=actor_membership.tenant_id
   WHERE actor_membership.tenant_id=$1 AND actor_membership.alias=$2
     AND actor_membership.enabled AND actor_role.${permissionColumn}
     AND actor_tenant.enabled AND actor_room.enabled
)
```

CITA LADO B (`context.ts:285-296`): idéntico byte-a-byte al LADO A salvo que `actor_role.${permissionColumn}` es `actor_role.allow_control` literal (gateway-side siempre es control) y el `OR EXISTS (... acl_edges ...)` posterior añade además la rama `$1=$3`.

HOGAR ÚNICO SUGERIDO: `packages/store/src/repository/agents/_actor-route.ts` exportando `actorHasRoutableMembership(actor: { tenant: Tenant, alias: string }, permission: 'read' | 'control'): Promise<boolean>`. El gateway (`context.ts`) importa y envuelve con la segunda condición sobre `acl_edges`. Dueño de `packages/store` y co-dueño de `services/gateway`: Codex.

RIESGO: **medio**. La lógica de permisos (columna dinámica vs literal) ya DIVERGE — `actor_role.${permissionColumn}` cubre `read` y `control`; el lado gateway sólo implementa `control`. Si se introduce un tercer permiso (`notify`), el lado gateway se queda ciego.

### G-14 — `DELEGATION_REJECTION_CODES` (subset duplicado) — 2 ocurrencias — 10 elementos solapados, 5 idénticos
- `packages/protocol/src/schemas.ts:902-913` (10 elementos, **canónico**)
- `packages/store/src/delegation-guard.ts:16-22` (`DELEGATION_DISCIPLINE_REJECTION_CODES`, 5 elementos, **subset**)

CITA LADO A (`schemas.ts:902-913`):
```
export const DELEGATION_REJECTION_CODES = [
  'invalid_output',
  'unroutable_alias',
  'ambiguous_alias',
  'hop_budget_exhausted',
  'cycle_detected',
  'fanout_exceeded',
  'edge_repeat_exceeded',
  'root_budget_exhausted',
  'chain_gated',
  'human_gate_opened'
] as const;
```

CITA LADO B (`delegation-guard.ts:16-22`): los últimos 5 elementos son idénticos a los 5 últimos del LADO A. Los 5 primeros faltan (`invalid_output`, `unroutable_alias`, `ambiguous_alias`, `hop_budget_exhausted`, `cycle_detected`) — están en `protocol/src` pero no en `store/src`.

HOGAR ÚNICO SUGERIDO: `packages/store/src/delegation-guard.ts` debe importar `DELEGATION_REJECTION_CODES` de `@cauce/protocol` y derivar el subset: `export const DELEGATION_DISCIPLINE_REJECTION_CODES = ['fanout_exceeded', 'edge_repeat_exceeded', 'root_budget_exhausted', 'chain_gated', 'human_gate_opened'] as const satisfies readonly (typeof DELEGATION_REJECTION_CODES)[number][];`. Dueño del paquete `store` y `protocol`: Codex.

RIESGO: **medio**. Si `protocol` añade un nuevo código al set (p. ej. `forbidden_by_policy`), el subset de `store` queda obsoleto y los chequeos en runtime del store dejarán de aceptarlo.

### G-15 — Forma del ACK de outbox (`event_id / attempt / claim_token / status / error / retry_after_ms`) — 3 ocurrencias — 6 campos cada una
- `packages/store/src/repository/outbox/contracts.ts:67-76` (`OutboxAck`)
- `services/gateway/src/app.ts:61-69` (`OutboxLeaseAck`)
- `services/telegram-bridge/src/types.ts:274-283` (`TelegramOriginRelayAck`)

CITA LADO A (`outbox/contracts.ts:67-76`):
```
export interface OutboxAck {
  event_id: string;
  attempt: number;
  claim_token: string;
  status: 'sent' | 'retry' | 'dead';
  error?: string;
  retry_after_ms?: number;
  /** Required by the gateway for wake ACKs; omitted only by legacy/direct non-gateway callers. */
  connection?: ConnectionSessionFence;
}
```

CITA LADO B (`app.ts:61-69`): los mismos 6 primeros campos son byte-a-byte; **DIFIERE** en `connection: ConnectionSessionFence` (REQUERIDO, no opcional).

CITA LADO C (`types.ts:274-283`): los mismos 6 primeros campos; **DIFIERE** en `effect_count?: number` (campo extra distinto) — `connection` no existe aquí.

HOGAR ÚNICO SUGERIDO: `packages/protocol/src/outbox-contracts.ts` exportando `OutboxAck` (con `connection?: ConnectionSessionFence` opcional) y `OutboxAckEffectCount`/`OutboxLeaseAck` como extensiones. El gateway debe importar y hacer `connection: ConnectionSessionFence` (required) por composición; `telegram-bridge` debe importar y añadir `effect_count?`. Dueño del paquete `protocol` (con extensiones en `gateway` y `telegram-bridge`): Codex (`protocol`) / Codex (gateway) / Gemini (`telegram-bridge`).

RIESGO: **ALTO**. Ya divergió: `store` lo declara opcional, `gateway` lo requiere. Un ACK que omite `connection` rompe el gateway silenciosamente porque TypeScript no se queja si el llamador hace `as OutboxLeaseAck`. Además, `telegram-bridge` lo redefine con un campo extra (`effect_count`) que ningún otro lado conoce — un campo que sale del bridge es invisible para `store` y `gateway`.

### G-16 — Preámbulo de parser JSON WebSocket (binary-check + try/parse + is-object guard) — 2 ocurrencias — 7 líneas cada una
- `services/terminal-relay/src/browser-leg.ts:68-75`
- `services/terminal-relay/src/session-limits.ts:202-209`

CITA LADO A (`browser-leg.ts:68-75`):
```
export function parseAttachRequest(data: RawData, isBinary: boolean): AttachRequest | undefined {
  if (isBinary) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText(data));
  } catch {
    return undefined;
  }
```

CITA LADO B (`session-limits.ts:202-209`): idéntico byte-a-byte al LADO A en las 6 primeras líneas (el `if (parsed === null || ...)` que sigue también coincide).

HOGAR ÚNICO SUGERIDO: `services/terminal-relay/src/_parse-json-frame.ts` exportando `parseJsonObjectFrame(data: RawData, isBinary: boolean): Record<string, unknown> | undefined`. Dueño de `services/terminal-relay`: Gemini.

RIESGO: **bajo**.

### G-17 — Parser de "epoch BigInt de relay claim" (`POSTGRES_BIGINT_MAX`) — 2 ocurrencias — 7 líneas cada una
- `services/gateway/src/terminal/relay-proxy/context.ts:58-65` (`relayClaimEpoch`)
- `services/terminal-relay/src/gateway-client.ts:152-164` (constante + cuerpo equivalente)

CITA LADO A (`context.ts:58-65`):
```
export function relayClaimEpoch(value: unknown): string | undefined {
  if (typeof value !== 'string' || !POSITIVE_BIGINT_PATTERN.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}
```

CITA LADO B (`gateway-client.ts:152, 164`): define la misma `POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n` (línea 152) y un cuerpo `return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined` dentro de un `try { ... } catch { return undefined; }` (línea 164, función que verifica epoch específicamente).

HOGAR ÚNICO SUGERIDO: mover `POSTGRES_BIGINT_MAX` y `POSITIVE_BIGINT_PATTERN` (y por tanto `relayClaimEpoch`) a `packages/protocol/src/postgres-bigint.ts`; ambos servicios importan. Dueño del paquete `protocol`: Codex (con export secundario para `services/terminal-relay` que es Gemini).

RIESGO: **bajo**. La constante `POSTGRES_BIGINT_MAX` está duplicada (línea 20 de context.ts y línea 152 de gateway-client.ts) — si una cambia, la otra queda con un cap distinto y el guard se desincroniza silenciosamente.

### G-18 — Helper `stringField(source, name): string | undefined` — 4 ocurrencias idénticas + 1 divergida — 3 líneas cada una
- `services/terminal-relay/src/gateway-client.ts:140-143` (idéntico)
- `services/terminal-relay/src/governance-read.ts:83-86` (idéntico)
- `services/terminal-relay/src/governance-write.ts:33-36` (idéntico)
- `services/terminal-relay/src/agent-hello.ts:129-132` (idéntico, **exportado**)
- `services/gateway/src/console/relay-governance-client.ts:59-62` (**DIVERGE**: omite `&& value.length > 0`)

CITA LADO A (`gateway-client.ts:140-143`):
```
function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
```

CITA LADO B (`agent-hello.ts:129-132`): idéntico al LADO A (con `export`).

CITA LADO C (`relay-governance-client.ts:59-62`): mismo nombre y firma pero cuerpo `return typeof value === 'string' ? value : undefined;` — **SIN** la guarda `&& value.length > 0`.

HOGAR ÚNICO SUGERIDO: `services/terminal-relay/src/_string-field.ts` exportando `stringField` (con la guarda de longitud). `relay-governance-client.ts` debe importar — al hacerlo, la divergencia actual (un `''` que pasa el filtro gateway pero no el filtro relay) queda cerrada. Dueño de `services/terminal-relay` y co-dueño de `services/gateway`: Gemini.

RIESGO: **ALTO**. La 5ª copia DIVERGIÓ: acepta string vacío `""`. Una ruta del gateway puede entregar `''` como campo "presente" a un consumidor del relay que lo rechaza. Es exactamente el patrón "validators out of sync" que el repo reconoce como riesgo.

## Resumen

| grupo | ocurrencias | líneas | paquetes implicados | riesgo |
|---|---:|---:|---|---|
| G-1  Codex project_doc parser + constantes | 2 | 41 | gateway + terminal-relay | medio |
| G-2  Creación de TerminalAuditContext | 5 | 9 | gateway | medio |
| G-3  Envoltorio BEGIN/COMMIT/ROLLBACK | 4 | 10 | gateway | bajo |
| G-4  UPDATE terminal_sessions claim takeover | 2 | 16 | gateway | bajo |
| G-5  SELECT membership.room_id con JOINs | 5 | 6 | store | medio |
| G-6  Validador ISO 8601 UTC estricto | 3 | 10 | gateway + terminal-relay | bajo |
| G-7  INSERT audit_events transaccional | 2 | 13 | gateway | bajo |
| G-8  replyError Auth/Authz/fallback | 2 | 12 | gateway | medio |
| G-9  DestinationRow vs EgressDestinationRow | 2 | 11 | store | ALTO |
| G-10 Clasificador de code-points hostiles | 3 | 7 | protocol + telegram-bridge | medio |
| G-11 Derivación UUID v7 desde SHA-256 | 4 | 5 | store | bajo |
| G-12 sleep(ms, signal) | 2 | 10 | telegram-bridge | bajo |
| G-13 Sub-SELECT EXISTS de actor routable | 2 | 13 | store + gateway | medio |
| G-14 DELEGATION_REJECTION_CODES subset | 2 | 10 | store + protocol | medio |
| G-15 Forma del ACK de outbox | 3 | 6 | store + gateway + telegram-bridge | ALTO |
| G-16 Preámbulo de parser JSON WS | 2 | 7 | terminal-relay | bajo |
| G-17 Parser de epoch BigInt (`relayClaimEpoch`) | 2 | 7 | gateway + terminal-relay | bajo |
| G-18 Helper `stringField` | 5 | 3 | terminal-relay + gateway | ALTO |

## Descartados (leídos a mano, NO son duplicación genuina)

- **`messages: [], notify: [], status: "done", retryable: false, artifacts: []`** en 6 sitios del paquete `adapter-sdk` (`system-gate-probe.ts:64`, `fanin-synthesizer.ts:209/278/293/337`, `output-parser/envelopes.ts:163`). Es un literal de inicialización de `StructuredOutput` con `reply` distinto en cada sitio — boilerplate de tipos que el contrato exige explícito. Descartado.
- **`Interface GatewayRepository` (`app.ts:77-183`) vs `ConsoleRouteRepository` (`routes/console.ts:35-119`)**: misma firma de métodos pero `ConsoleRouteRepository` es un narrowing intencional (interface segregation) — no es copy-paste por accidente, es diseño. Descartado.
- **`Cache-Control: no-store` en oidc-bff.ts:646 y password-auth.ts:440**: una sola línea compartida, no es un bloque a unificar. Descartado.
- **`actor_membership` row type en `telegram-bridge/src/repository.ts:36` vs `TelegramEffect` interface en `types.ts:251`**: ambas listas de campos coinciden en los primeros 6 nombres, pero son tipos con semánticas distintas (SELECT row vs interface declarada). Coincidencia, no copy-paste. Descartado.

## Método y umbrales

- Detector en `/tmp/opencode/dup-detector/detect.mjs` (Node.js): normaliza cada fichero (elimina `/* … */` y `// …`, colapsa espacios múltiples, conserva identificadores), genera ventanas de N=6 y N=10 líneas consecutivas **no-neutras** (ninguna línea con contenido vacío tras normalizar), hashea con SHA-1, agrupa por hash, filtra `≥2 ficheros` y `≥2 ocurrencias`. Anclaje por las 3 primeras líneas normalizadas para colapsar solapamientos de sliding-window en un único bloque lógico.
- Verificación manual de los 18 grupos: lectura de ambos lados línea a línea, identificación de divergencias reales, descarte de los 4 casos listados al final.
- Total mecánico sin filtro de boilerplate: 296 bloques anclados. Tras descarte: 18.