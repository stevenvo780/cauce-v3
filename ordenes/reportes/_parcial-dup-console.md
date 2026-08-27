# Auditoría de duplicación — sector tests/console (console/** + tests/** + tests de packages/store, packages/adapter-sdk, services/**)

Sector: 320 ficheros `.ts/.tsx/.css/.mts/.mjs` en `console/**` (test, fuente, css), `tests/**`, `packages/store/test/**`, `packages/adapter-sdk/test/**`, `services/dispatcher/test/**`, `services/telegram-bridge/test/**`, `services/terminal-relay/src/**/*.test.ts`, `services/gateway/src/**/*.test.ts` (los tests de servicios son del sector según la orden). Detector mecánico (`/tmp/opencode/dup-scan/dup.mjs`): normaliza (elimina `/* … */`, `// …` y `<!-- -->`, colapsa espacios), genera todas las ventanas de N líneas consecutivas no-neutras, agrupa por SHA-1, filtra `≥2 ficheros` y `≥2 ocurrencias`. Probado con N=6 y N=10. Salida bruta: 2665 grupos; verificación manual lectura de ambos lados descarta falsos positivos (boilerplate `describe`, `import` lícitos, aserciones legítimamente repetidas sobre casos distintos).

Total mecánico: 2665 ventanas (1669 a N=6 + 996 a N=10, solapadas). Confirmados a mano: **13**. Descartados: ≈2652 (boilerplate de imports, `describe(...)`, asserts que parecen iguales pero verifican propiedades distintas del mismo caso, fixtures con datos diferentes por archivo — ej. `body.text` distinto en cada `command()`). Estimación de líneas-físicas duplicadas confirmadas: **≈580 línea-ocurrencias** (= Σ ocurrencias × líneas por bloque; ver tabla resumen).

## Caso del @import — medición exacta pedida

- **`@import` repetidos en los CSS de console**: 13 ocurrencias totales en **3 ficheros** (no hay ninguno repetido entre sí: cada `@import` apunta a un fichero destino distinto):
  - `console/src/styles.css` — 4 (base/components/views/responsive)
  - `console/src/features/terminal/xterm-csp.css` — 3 (terminal/ansi-base/ansi-cube)
  - `console/src/features/live/live.css` — 6 (avatar/fleet/drawer/directiva-modal/ficheros/perfil)
- **El caso "11 veces"** que disparó la orden NO es de CSS sino del **resolutor recursivo de `@import`** que vive en los tests: el patrón `return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => { ... return leerCss(subAbs); })` aparece **en 15 ficheros distintos** (no 11 — medición directa con `grep -lr 'replace(/@import' console/src --include='*.test.*' | wc -l` = **15**):
  - `console/src/styles.tipografia.test.ts:14`
  - `console/src/styles.legibilidad.test.ts:9`
  - `console/src/styles.legibilidad-themes.test.ts:9`
  - `console/src/styles.tipografia-montada.test.tsx:20`
  - `console/src/contraste-cascada.test.ts:8`
  - `console/src/menu-movil.test.ts:38`
  - `console/src/components/view-tabs-legibilidad.test.ts:24`
  - `console/src/features/messages/composer-anclado.test.ts:15`
  - `console/src/features/messages/messages-css.test.ts:39`
  - `console/src/features/terminal/xterm-csp.test.ts:30` (variable `content`/`relPath` en lugar de `contenido`/`importPath`, único diverge)
  - `console/src/features/live/tira-de-pestanas.test.ts:11`
  - `console/src/features/live/perfil-css.test.ts:10`
  - `console/src/features/live/ficheros-legibilidad.test.ts:27`
  - `console/src/features/config/config-css-toggles.test.ts:9`
  - `console/src/features/config/config-css.test.ts:9`

---

## Grupos confirmados (13)

#### G-1 — Resolutor recursivo de `@import` para tests de CSS (`leer` / `leerCss` / `resolverCss`) — 15 ocurrencias — 6 líneas cada una
- `console/src/styles.tipografia.test.ts:11-18`
- `console/src/styles.legibilidad.test.ts:6-13`
- `console/src/styles.legibilidad-themes.test.ts:6-13`
- `console/src/styles.tipografia-montada.test.tsx:17-24`
- `console/src/contraste-cascada.test.ts:5-12`
- `console/src/menu-movil.test.ts:34-41`
- `console/src/components/view-tabs-legibilidad.test.ts:21-28`
- `console/src/features/messages/composer-anclado.test.ts:11-18`
- `console/src/features/messages/messages-css.test.ts:35-42`
- `console/src/features/terminal/xterm-csp.test.ts:27-34`
- `console/src/features/live/tira-de-pestanas.test.ts:9-15`
- `console/src/features/live/perfil-css.test.ts:8-14`
- `console/src/features/live/ficheros-legibilidad.test.ts:25-32`
- `console/src/features/config/config-css-toggles.test.ts:5-12`
- `console/src/features/config/config-css.test.ts:6-13`

CITA LADO A (`styles.legibilidad.test.ts:6-13`):
```
const leerCss = (ruta: string): string => {
  const abs = resolve(RAIZ, ruta);
  const contenido = readFileSync(abs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(abs, '..', importPath);
    return leerCss(subAbs);
  });
};
```

CITA LADO B (`features/config/config-css.test.ts:6-13`):
```
const resolverCss = (ruta: string): string => {
  const abs = resolve(RAIZ, ruta);
  const contenido = readFileSync(abs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(abs, '..', importPath);
    return resolverCss(subAbs);
  });
};
```

Difiere solo en el nombre de la función (`leer`/`leerCss`/`resolverCss`). Una variante (tira-de-pestanas.test.ts, perfil-css.test.ts, ficheros-legibilidad.test.ts, view-tabs-legibilidad.test.ts, xterm-csp.test.ts) opera sobre ruta absoluta y se salta el `RAIZ`. La `xterm-csp.test.ts:27-34` también diverge en nombres de variable local (`content`/`relPath`).

HOGAR ÚNICO SUGERIDO: `console/src/test/leer-css.ts` exportando `leerCss(absPath: string): string` y `leerCssDesdeRaiz(relPath: string): string` (con `RAIZ = resolve(process.cwd(), 'src')` interno, fijable también como argumento). Los tests importarían `leerCssDesdeRaiz` por defecto. Tests que necesitan ruta absoluta (`tira-de-pestanas.test.ts:16`, `perfil-css.test.ts:15`) importarían `leerCss`. Dueño `console/**`: Gemini.

RIESGO: **alto**. Ya hay fork: `xterm-csp.test.ts:27-34` renombró a `content`/`relPath`, lo que rompe la copia-pega silenciosa; los 3 tests que pasan ruta absoluta usan una segunda variante; y un fix de bugs en uno (p. ej. ciclo `@import` infinito, `@import` con `url(...)` no soportado) sólo se aplicaría a una parte del lote. 15 ficheros = 15 sitios a tocar hoy.

---

#### G-2 — `afterAll` de cierre del pool de tests postgres (`if (pool) await pool.end(); if (database?.container) await database.container.stop();`) — 28 ocurrencias — 4 líneas cada una
- `tests/store-hardening/adversarial-postgres.test.ts:64-67`
- `tests/store-hardening/agent-registry-postgres.test.ts:36-39`
- `tests/store-hardening/configuration-postgres.test.ts:45-48`
- `tests/store-hardening/agent-role-brief-postgres.test.ts:47-50`
- `tests/store-hardening/oidc-session-postgres.test.ts:43-46`
- `tests/store-hardening/gate-collector-postgres.test.ts:42-45`
- `tests/store-hardening/account-selector-postgres.test.ts:39-42`
- `tests/store-hardening/quota-ingest-conflict-postgres.test.ts:21-24`
- `tests/store-hardening/terminal-admission-postgres.test.ts:36-39`
- `packages/store/test/agent-chain-visibility-postgres.test.ts:178-181`
- `packages/store/test/agent-output-postgres.test.ts:251-254`
- `packages/store/test/ambiguous-without-execution-postgres.test.ts:121-124`
- `packages/store/test/audit-pagination-postgres.test.ts:26-29`
- `packages/store/test/catalogo-no-se-filtra.test.ts:20-23`
- `packages/store/test/chain-silence-sweep-postgres.test.ts:190-193`
- `packages/store/test/console-publish-intent-postgres.test.ts:109-112`
- `packages/store/test/delegation-discipline-postgres.test.ts:203-206`
- `packages/store/test/delivery-admission-postgres.test.ts:120-123`
- `packages/store/test/delivery-concurrency-postgres.test.ts:30-33`
- `packages/store/test/egress-notification-postgres.test.ts:225-228`
- `packages/store/test/failure-notice-coalescing-postgres.test.ts:185-188`
- `packages/store/test/fleet-reconciliation-postgres.test.ts:48-51`
- `packages/store/test/late-terminal-ack-postgres.test.ts:84-87`
- `packages/store/test/lease-cap-postgres.test.ts:116-119`
- `packages/store/test/muestra-no-es-total.test.ts:24-27`
- `packages/store/test/observability-retention-postgres.test.ts:106-109`
- `packages/store/test/priority-band-postgres.test.ts:67-70`
- `packages/store/test/queue-heartbeat-postgres.test.ts:99-102`
- `packages/store/test/replay-postgres.test.ts:97-100`
- `packages/store/test/retry-policy-postgres.test.ts:118-121`
- `packages/store/test/terminal-recovery-postgres.test.ts:136-139`
- `packages/store/test/topology-registry-postgres.test.ts:81-84`
- `packages/store/test/visited-path-fallback-postgres.test.ts:178-181`

CITA LADO A (`agent-chain-visibility-postgres.test.ts:178-181`):
```
afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});
```

CITA LADO B (`lease-cap-postgres.test.ts:116-119`):
```
afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});
```

Exactamente igual. Variante minoritaria: `catalogo-no-se-filtra.test.ts:20-23` omite la guarda `if (pool)` porque ya está en el `let` superior; `console-publish-intent-postgres.test.ts:109-112` y `delivery-admission-postgres.test.ts:120-123` también.

HOGAR ÚNICO SUGERIDO: añadir `closeTestDatabase(database: TestDatabase | undefined): Promise<void>` (y `closeTestPool(pool: DatabasePool | undefined)`) en `tests/helpers/postgres.ts`, ya existente. Cada test haría `afterAll(async () => { await closeTestDatabase(database); });` — 28 sitios a tocar. Dueño `tests/**` = Gemini; tests de `packages/store/test/**` = Codex según protocolo. **Sin conflicto**: la modificación es en `tests/helpers/postgres.ts`, que ya es sector Gemini; los usos están en ambos sectores y son edit-in-place.

RIESGO: **medio**. La mayoría de los sitios son byte-idénticos; no hay divergencia funcional detectada. Pero el patrón "test que se olvida del `container.stop()`" es exactamente el modo de fallo que llevó a este protocolo (un docker colgado durante una sesión larga). Centralizarlo hace ese olvido imposible.

---

#### G-3 — Fixture `function command(overrides: Partial<PublishMessage> = {})` — 13 ocurrencias — 16 líneas cada una
- `tests/store-hardening/adversarial-postgres.test.ts:18-33`
- `packages/store/test/agent-chain-visibility-postgres.test.ts:22-37`
- `packages/store/test/agent-output-postgres.test.ts:33-48`
- `packages/store/test/chain-silence-sweep-postgres.test.ts:28-43`
- `packages/store/test/delegation-discipline-postgres.test.ts:31-46`
- `packages/store/test/delivery-admission-postgres.test.ts:24-39`
- `packages/store/test/delivery-concurrency-postgres.test.ts:39-54`
- `packages/store/test/egress-notification-postgres.test.ts:32-47`
- `packages/store/test/failure-notice-coalescing-postgres.test.ts:20-35`
- `packages/store/test/late-terminal-ack-postgres.test.ts:23-38`
- `packages/store/test/priority-band-postgres.test.ts:29-44`
- `packages/store/test/publish-receipt-postgres.test.ts:15-30`
- `packages/store/test/terminal-recovery-postgres.test.ts:31-46`
- `packages/store/test/visited-path-fallback-postgres.test.ts:13-28`

CITA LADO A (`agent-chain-visibility-postgres.test.ts:22-37`):
```
function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'chain visibility source' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}
```

CITA LADO B (`priority-band-postgres.test.ts:29-44`):
```
function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { type: 'telegram.message', text: 'from a person' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}
```

Diferencias legítimas (no fork), cada test cambia el `actor_alias`, `body.text`, `recipients` o `priority` para su caso. La estructura `version: '3.0' / request_id / trace_id / tenant_id / room_id / lane: 'interactive' / ...overrides` es idéntica en los 13.

HOGAR ÚNICO SUGERIDO: `tests/store-hardening/_fixtures/command.ts` (o `packages/store/test/command-fixture.ts`) exportando `commandFixture(overrides: Partial<PublishMessage> = {}): PublishMessage` con los defaults más neutros (Steven/kant/argos, body genérico, priority 7, lane 'interactive'). Cada test hace `command({ body: { text: 'caso X' }, actor_alias: 'x' })`. **Resuelve propiedad**: 13 archivos × 16 líneas = 208 líneas duplicadas.

RIESGO: **bajo**. No hay divergencia funcional, solo variantes intencionales por el `...overrides` final. Pero si un día se añade `headers` al `PublishMessage` schema (versión 3.1), hay que tocar 13 sitios a la vez. Ya hay un riesgo real en `actor_alias: 'kant'` vs `'argos'` vs `'salva'` — un test que asume el alias por defecto pero otro lo cambió silente.

---

#### G-4 — Bloque `beforeEach` con `UPDATE acl_edges / tenants / rooms / memberships / role_policies SET enabled=true` — 14 ocurrencias — 7 líneas cada una
- `packages/store/test/agent-chain-visibility-postgres.test.ts:167-176`
- `packages/store/test/agent-output-postgres.test.ts:241-250`
- `packages/store/test/ambiguous-without-execution-postgres.test.ts:112-121`
- `packages/store/test/chain-silence-sweep-postgres.test.ts:179-188`
- `packages/store/test/delegation-discipline-postgres.test.ts:193-202`
- `packages/store/test/egress-notification-postgres.test.ts:206-215`
- `packages/store/test/failure-notice-coalescing-postgres.test.ts:169-178`
- `packages/store/test/lease-cap-postgres.test.ts:105-114`
- `packages/store/test/materialization-crosstenantroom-postgres.test.ts:67-76`
- `packages/store/test/muestra-no-es-total.test.ts:41-50`
- `packages/store/test/observability-retention-postgres.test.ts:88-97`
- `packages/store/test/queue-heartbeat-postgres.test.ts:81-90`
- `packages/store/test/replay-postgres.test.ts:79-88`
- `packages/store/test/retry-policy-postgres.test.ts:100-109`
- `packages/store/test/terminal-recovery-postgres.test.ts:115-124`
- `packages/store/test/visited-path-fallback-postgres.test.ts:160-169`

CITA LADO A (`delegation-discipline-postgres.test.ts:193-202`):
```
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});
```

CITA LADO B (`lease-cap-postgres.test.ts:105-114`):
```
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true,allow_read=true WHERE role='agent';
  `);
});
```

Diferencias: `egress-notification-postgres.test.ts:209` cambia `memberships SET enabled=true,role='agent'`, `egress-notification-postgres.test.ts:210` añade `DELETE FROM role_policies WHERE role='agent_notify'`, `lease-cap-postgres.test.ts:112` usa `role='agent'` y `allow_read=true`. Las **5 primeras líneas son byte-idénticas**; lo que cambia es la última (`role_policies`). Las primeras 5 (acl_edges+tenants+rooms+memberships) son la "política común".

HOGAR ÚNICO SUGERIDO: `tests/store-hardening/_fixtures/enable-everything.ts` (o `tests/helpers/enable-everything.ts`) exportando `enableEverything(pool: DatabasePool): Promise<void>` con el bloque común; tests con variantes (lease-cap, egress-notification) la llaman y sobreescriben `role_policies` después. Alternativa: añadir un parámetro `enabledRoles?: string[]` al helper. Dueño del código (`tests/helpers/postgres.ts`): Gemini; los usos están en `packages/store/test/**` (Codex) y `tests/store-hardening/**` (Gemini).

RIESGO: **alto**. Ya divergió: `egress-notification-postgres.test.ts:208-218` cambió 3 líneas y `lease-cap-postgres.test.ts:108-113` cambió la última línea. Si alguien añade una nueva tabla (p. ej. `update role_policies SET allow_control=true`), el sitio común a tocar son 16.

---

#### G-5 — Setup `apps + sockets` + `afterEach` cierra ambos (`for (const socket of sockets.splice(0)) socket.close(); await Promise.all(apps.splice(0).map(async (app) => app.close()));`) — 8 ocurrencias — 7 líneas cada una
- `tests/gateway-hardening/ack-result-frame-gating.test.ts:33-39`
- `tests/gateway-hardening/delivery-admission.test.ts:16-22`
- `tests/gateway-hardening/delivery-drain-capacity.test.ts:20-26`
- `tests/gateway-hardening/perfil-en-el-saludo.test.ts:89-95`
- `tests/gateway-hardening/terminal-ack-replay-postgres.test.ts:21-27`
- `tests/gateway-hardening/wake-outbox-postgres.test.ts:19-25` (líneas 41-43 del `afterEach`)
- `tests/gateway-hardening/wake-outbox-routing.test.ts:14-20`
- `tests/gateway-hardening/websocket-correlation.test.ts:9-15`

CITA LADO A (`ack-result-frame-gating.test.ts:33-39`):
```
const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});
```

CITA LADO B (`delivery-drain-capacity.test.ts:20-26`):
```
const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});
```

Byte-idéntico. `terminal-ack-replay-postgres.test.ts:21-27` y `wake-outbox-postgres.test.ts:19-25` declaran `apps` con `Gateway[]` tipado (un type alias local de 1 línea) y guardan sockets en posición similar.

HOGAR ÚNICO SUGERIDO: exportar `const gatewayApps = ...` (símbolo mutable) y `const sockets = ...` + `function closeAllGateways(): Promise<void>` desde `tests/gateway-hardening/helpers.ts` (que ya existe y exporta `fakePool`/`fakeRepository`). Cada test hace `closeAllGateways()` en su `afterEach`. **Pero los tests de `services/gateway/src/*.test.ts`** (5+ archivos) usan solo `apps` con `afterEach(async () => { while (apps.length > 0) await apps.pop()?.close(); });` — distinto pero el mismo concepto (G-6). El hogar único debe cubrir ambos.

RIESGO: **medio**. Las 8 copias son byte-idénticas hoy. Pero un nuevo patrón de cleanup (p. ej. drain de inflight promises antes de `close()`) obligaría a editar 8 sitios.

---

#### G-6 — `function text(data: RawData): string` (frame WebSocket → string) — 8 ocurrencias — 6 líneas cada una
- `tests/gateway-hardening/ack-result-frame-gating.test.ts:41-46`
- `tests/gateway-hardening/delivery-admission.test.ts:25-30`
- `tests/gateway-hardening/delivery-drain-capacity.test.ts:28-33`
- `tests/gateway-hardening/perfil-en-el-saludo.test.ts:97-102`
- `tests/gateway-hardening/terminal-ack-replay-postgres.test.ts:48-53`
- `tests/gateway-hardening/wake-outbox-postgres.test.ts:45-50`
- `tests/gateway-hardening/wake-outbox-routing.test.ts:26-31`
- `tests/gateway-hardening/websocket-correlation.test.ts:17-22`

CITA LADO A (`ack-result-frame-gating.test.ts:41-46`):
```
function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
```

CITA LADO B (`websocket-correlation.test.ts:17-22`):
```
function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
```

Byte-idéntico, 8 copias.

HOGAR ÚNICO SUGERIDO: exportar `text(data: RawData): string` desde `tests/gateway-hardening/helpers.ts` (junto con `fakePool`/`fakeRepository`/`ids` ya existentes). 8 sitios a importar. Dueño `tests/**` = Gemini.

RIESGO: **bajo**. No ha divergido. Pero el `RawData` type es del paquete `ws`; un cambio en su shape (Node 22+ ya normaliza más casos) forzaría 8 ediciones.

---

#### G-7 — `interface Consumer` + `async function consumer(tenant, alias)` (helper de lease para tests postgres) — 6 ocurrencias — 8 líneas cada una
- `packages/store/test/agent-chain-visibility-postgres.test.ts:39-50`
- `packages/store/test/chain-silence-sweep-postgres.test.ts:49-60`
- `packages/store/test/delegation-discipline-postgres.test.ts:48-59`
- `packages/store/test/delivery-concurrency-postgres.test.ts:56-67`
- `packages/store/test/failure-notice-coalescing-postgres.test.ts:37-48`
- `packages/store/test/visited-path-fallback-postgres.test.ts:30-41`

CITA LADO A (`agent-chain-visibility-postgres.test.ts:39-50`):
```
interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  return { tenant, alias, instanceId, epoch: lease.epoch! };
}
```

CITA LADO B (`chain-silence-sweep-postgres.test.ts:49-60`):
```
interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  return { tenant, alias, instanceId, epoch: lease.epoch! };
}
```

Byte-idéntico. La función va acompañada de `nextDelivery()` (mismo target con `repository.claimDeliveries(target.tenant, target.alias, target.instanceId, target.epoch, 10|20, 30_000)`) en 4 de los 6 — `agent-chain-visibility-postgres.test.ts:52`, `chain-silence-sweep-postgres.test.ts:62` (usa `20` en lugar de `10`), `delegation-discipline-postgres.test.ts:61`, `delivery-concurrency-postgres.test.ts:68`. `terminalAck()` también vive en 4 de los 6.

HOGAR ÚNICO SUGERIDO: `packages/store/test/_fixtures/consumer.ts` (sector `packages/store/test/**` = Codex) exportando `Consumer` interface, `consumer(tenant, alias)`, `nextDelivery(target, predicate?)`, `terminalAck(delivery, target, messages, reply?, eventId?)`. 6 sitios a importar. **Tamaño**: ~30 líneas × 6 = 180 línea-ocurrencias (sumando `nextDelivery` y `terminalAck` adyacentes, son el mismo bloque conceptual).

RIESGO: **medio**. La interfaz no ha divergido. La función `consumer` no ha divergido. Pero `chain-silence-sweep-postgres.test.ts:67` usa `20` en lugar de `10` como `batchSize` de `claimDeliveries` — es una divergencia intencional, pero también es la prueba de que el helper "no parametriza lo que debería parametrizar". Si el batchSize se vuelve a cambiar (p. ej. a 50), hay que tocar 2+ sitios.

---

#### G-8 — Helpers de migración `shadowPhaseExists` + `consolePublishIndexesExist` — 4 ocurrencias — 8 líneas cada uno
- `packages/store/test/agent-profile-runtime-adoption-migration-postgres.test.ts:45-53` (shadowPhaseExists) + `:68-74` (consolePublishIndexesExist)
- `packages/store/test/terminal-browser-owner-fencing-migration-postgres.test.ts:155-162` (shadowPhaseExists) + `:143-150` (consolePublishIndexesExist)
- `packages/store/test/terminal-relay-instance-fencing-migration-postgres.test.ts:139-146` (shadowPhaseExists) + `:127-134` (consolePublishIndexesExist)
- `packages/store/test/terminal-session-claim-fencing-migration-postgres.test.ts:164-171` (shadowPhaseExists) + `:152-159` (consolePublishIndexesExist)

CITA LADO A (`terminal-session-claim-fencing-migration-postgres.test.ts:152-159`):
```
async function consolePublishIndexesExist(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.audit_events_console_publish_key_037_idx') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
}
```

CITA LADO B (`terminal-relay-instance-fencing-migration-postgres.test.ts:127-134`):
```
async function consolePublishIndexesExist(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.audit_events_console_publish_key_037_idx') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
}
```

Byte-idéntico en los 4. Lo mismo aplica a `shadowPhaseExists()` (8 líneas contra `information_schema.columns`). Acompañado por `removeLatestShadowPhase`/`restoreLatestShadowPhase`/`removeLatestConsolePublishIndexes`/`restoreLatestConsolePublishIndexes` — 4 funciones más, **4 copias cada una** = 16 funciones auxiliares duplicadas en 4 ficheros de migración.

HOGAR ÚNICO SUGERIDO: `packages/store/test/_fixtures/migration-phase.ts` (sector `packages/store/test/**` = Codex) exportando todas las auxiliares de las migraciones 036/037 (`shadowPhaseExists`, `consolePublishIndexesExist`, `removeLatestShadowPhase`, `restoreLatestShadowPhase`, `removeLatestConsolePublishIndexes`, `restoreLatestConsolePublishIndexes`). 4 sitios a importar. **Tamaño**: ~30 líneas × 4 = 120 línea-ocurrencias solo de las auxiliares (sin contar las migraciones `up036/down036`).

RIESGO: **medio**. No ha divergido. Pero ya hay un caso de fichero que importa `markApplied` (G-9) — los helpers de migración deberían vivir todos en el mismo archivo.

---

#### G-9 — `apps: Array<...> = []` + `afterEach(async () => { while (apps.length > 0) await apps.pop()?.close(); });` — 5 ocurrencias — 5 líneas cada una
- `services/gateway/src/console-message-body.test.ts:11,54-56`
- `services/gateway/src/console-dlq.test.ts:13,104-106` (tipo declarado como `let apps: App[] = []`)
- `services/gateway/src/console-publish-intent.test.ts:23,193-195`
- `services/gateway/src/console-audit.test.ts:11,58-60`
- `services/gateway/src/publish-priority.test.ts:18,117-119`

CITA LADO A (`console-message-body.test.ts:11,54-56`):
```
const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});
```

CITA LADO B (`console-audit.test.ts:11,58-60`):
```
const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});
```

Byte-idéntico entre los 5. Variante en `console-dlq.test.ts:13`: usa `let apps: App[] = []` con `type App = Awaited<ReturnType<typeof buildGateway>>` local.

HOGAR ÚNICO SUGERIDO: mismo archivo que G-5: `tests/gateway-hardening/helpers.ts` exportando `const gatewayApps: Array<...> = []` y `closeGatewayApps(): Promise<void>`. Pero atención: **estos tests están en `services/gateway/src/*.test.ts`** (sector Codex, no Gemini). El hogar único correcto es **`services/gateway/src/__test-helpers__/close-apps.ts`** (nuevo), y los tests de `tests/gateway-hardening/**` (G-5, sector Gemini) importarían de `services/gateway/src/__test-helpers__/close-apps.js`. **Conflicto de sector**: hay que decidir quién lo crea; por orden del protocolo, el código fuente de `services/gateway/src/**` es de Codex, así que el hogar único debe estar allí y Gemini lo importa.

RIESGO: **bajo**. No hay divergencia. Pero los 5 ficheros en `services/gateway/src/` + los 8 en `tests/gateway-hardening/**` (G-5) deberían compartir el mismo helper. Si no, el "mismo helper en dos zonas" se mantiene como fork latente.

---

#### G-10 — `function pool(): DatabasePool { return { query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })) } as unknown as DatabasePool; }` — 8 ocurrencias — 3 líneas cada una
- `tests/gateway-hardening/helpers.ts:57-59` (con nombre `fakePool`, retorna `[{ '?column?': 1 }]`)
- `services/gateway/src/console-audit.test.ts:8-10`
- `services/gateway/src/console-dlq.test.ts:11-13`
- `services/gateway/src/console-message-body.test.ts:13-15`
- `services/gateway/src/console-publish-intent.test.ts:19-23`
- `services/gateway/src/mtls-health.test.ts:9-13`
- `services/gateway/src/oidc-bff.test.ts:35-39` (con nombre `fakePool`)
- `services/gateway/src/password-auth.test.ts:22-24` (con nombre `fakePool`)
- `services/gateway/src/publish-priority.test.ts:24-28`

CITA LADO A (`tests/gateway-hardening/helpers.ts:57-59`):
```
export function fakePool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })) } as unknown as DatabasePool;
}
```

CITA LADO B (`services/gateway/src/console-message-body.test.ts:13-15`):
```
function pool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })) } as unknown as DatabasePool;
}
```

Diferencias: (a) nombre `fakePool`/`pool`/`repository` (3 nombres distintos), (b) shape de la row devuelta (`{ '?column?': 1 }` vs `{ ssl: true }` — el primero es el shape real de un `SELECT 1`, el segundo parece copy-paste sin pensar). Cuerpo idéntico al `vi.fn(...)`.

HOGAR ÚNICO SUGERIDO: `services/gateway/src/__test-helpers__/pool.ts` exportando `fakePool(): DatabasePool` (con el shape `{ '?column?': 1 }` que es el correcto). Dueño: Codex (sector `services/gateway/src/**`). `tests/gateway-hardening/helpers.ts:57` se borra y se re-exporta desde allí.

RIESGO: **alto**. Ya divergió en el shape de la row (`?column?` vs `ssl`). Si un día se añade `connect()` al pool (lo cual hace la firma `DatabasePool`), hay que tocar 9 sitios; si solo se tocan los 8 de `services/gateway/src/`, el de `tests/gateway-hardening/helpers.ts` queda roto. Es exactamente el caso "el mismo helper escrito en tests/gateway-hardening y en services/gateway/src/*.test.ts" que la orden menciona.

---

#### G-11 — Preámbulo `const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');` + imports `spawnSync + tmpdir + join + resolve + fileURLToPath` — 13 ocurrencias — 6 líneas cada una
- `tests/unit/canary-gate.test.ts:1-9`
- `tests/unit/compose-files.test.ts:1-9`
- `tests/unit/dockerfile-runtime-policy.test.ts:1-8`
- `tests/unit/gate-roundtrip-probe.test.ts:3-8`
- `tests/unit/host-backup-monitor.test.ts:1-9`
- `tests/unit/inactive-override-manifest.test.ts:1-8`
- `tests/unit/migration-gate.test.ts:1-9`
- `tests/unit/physical-fleet-gate.test.ts:1-9`
- `tests/unit/postgres-tls-policy.test.ts:1-7`
- `tests/unit/provision-terminal-client.test.ts:1-8`
- `tests/unit/source-digest-closure.test.ts:1-7`
- `tests/unit/stack-health-arguments.test.ts:1-7`
- `tests/unit/testcontainers-evidence.test.ts:1-7`

CITA LADO A (`canary-gate.test.ts:1-9`):
```
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ops = join(repository, 'ops');
```

CITA LADO B (`physical-fleet-gate.test.ts:1-9`):
```
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
```

Diferencia: los `node:fs/promises` importados varían por fichero según lo que el test use (algunos no necesitan `chmod`/`readFile`). Lo idéntico son las 4 líneas de `node:child_process`+`node:os`+`node:path`+`node:url`+`vitest` y la línea `const repository = ...`.

HOGAR ÚNICO SUGERIDO: añadir `export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');` en `tests/helpers/repository-root.ts` (nuevo, sector Gemini) y re-exportar desde `tests/unit/_setup.ts`. Cada test importa `repository` y elimina la línea.

RIESGO: **bajo**. Es preámbulo idéntico; el resolver no cambia. Pero son 13 sitios que podrían unificarse trivialmente.

---

#### G-12 — `function sinComentarios(css: string): string { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }` — 6 ocurrencias — 3 líneas cada una
- `console/src/styles.tipografia.test.ts:37-39`
- `console/src/styles.legibilidad.test.ts:16-18`
- `console/src/styles.legibilidad-themes.test.ts:16-18`
- `console/src/features/messages/composer-anclado.test.ts:26-28`
- `console/src/features/config/config-css-toggles.test.ts:18-20`
- `console/src/features/config/config-css.test.ts:18-20`

CITA LADO A (`styles.legibilidad.test.ts:16-18`):
```
function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}
```

CITA LADO B (`styles.legibilidad-themes.test.ts:16-18`):
```
function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}
```

Byte-idéntico, 6 copias.

HOGAR ÚNICO SUGERIDO: `console/src/test/leer-css.ts` (mismo hogar que G-1) exportando `sinComentarios`. Dueño Gemini.

RIESGO: **bajo**. Función trivial, no diverge. Pero ya va de la mano de `leerCss`/`resolverCss` en cada fichero: unificar las 3 funciones juntas (`leerCss`, `sinComentarios`, `bloqueMedia` — G-13) cierra los 3 grupos de golpe.

---

#### G-13 — `function bloqueMedia(css, consulta)` (extracción de cuerpo de `@media` con conteo de llaves) — 4 ocurrencias — 18 líneas cada una
- `console/src/styles.legibilidad.test.ts:20-36`
- `console/src/styles.legibilidad-themes.test.ts:20-36`
- `console/src/features/messages/composer-anclado.test.ts:34-50`
- `console/src/menu-movil.test.ts:53-69`

CITA LADO A (`styles.legibilidad.test.ts:20-36`):
```
function bloqueMedia(css: string, consulta: string): string {
  const limpio = sinComentarios(css);
  const inicio = limpio.indexOf(consulta);
  if (inicio < 0) return '';
  let profundidad = 0;
  let cursor = limpio.indexOf('{', inicio);
  if (cursor < 0) return '';
  const desde = cursor + 1;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}
```

CITA LADO B (`menu-movil.test.ts:53-69`):
```
function bloqueMedia(css: string, consulta: string): string {
  const limpio = sinComentarios(css);
  const inicio = limpio.indexOf(consulta);
  if (inicio < 0) return '';
  let profundidad = 0;
  let cursor = limpio.indexOf('{', inicio);
  if (cursor < 0) return '';
  const desde = cursor + 1;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}
```

Byte-idéntico. Acompañado de `function declaraciones()` (5 copias byte-idénticas en 5 ficheros: legibilidad.test.ts:38, legibilidad-themes.test.ts:38, composer-anclado.test.ts:53, menu-movil.test.ts:71, y una variante con signature distinta en `config-css-toggles.test.ts:22`/`config-css.test.ts:36`) y `function valor()` (4 copias byte-idénticas en los 4 mismos + 1 variante). El trío `sinComentarios + bloqueMedia + declaraciones + valor` está copiado en bloque.

HOGAR ÚNICO SUGERIDO: `console/src/test/css-parser.ts` exportando `sinComentarios`, `bloqueMedia`, `declaraciones`, `valor`, `reglasDe` (este último ya está exportado desde `styles.legibilidad.test.ts:66` pero solo se consume en ese fichero). El bloque CSS-parser entero unifica G-1 (parcialmente — `leerCss` se queda separado), G-12 y G-13. Dueño Gemini.

RIESGO: **medio**. Las 4 copias de `bloqueMedia` no han divergido. Pero `declaraciones` ya tiene 2 firmas distintas: `declaraciones(bloque, selector): string` (legibilidad/menu-movil/legibilidad-themes/composer-anclado) y `declaraciones(css, clase): Record<string, string>` (config-css-toggles/config-css). La divergencia es semántica: la primera devuelve el último bloque declarado, la segunda devuelve un mapa `propiedad→valor`. Si se centraliza, hay que mantener las dos firmas.

---

## Tabla resumen

| grupo | ocurrencias | líneas c/u | zonas implicadas | riesgo |
|---|---:|---:|---|---|
| G-1 — `leer`/`leerCss`/`resolverCss` con regex `@import` | 15 | 6 | `console/src/**/*.test.{ts,tsx}` | alto |
| G-2 — `afterAll` `pool.end()` + `container.stop()` | 28+ | 4 | `packages/store/test/**`, `tests/store-hardening/**`, `tests/gateway-hardening/**` | medio |
| G-3 — `function command(overrides: Partial<PublishMessage>)` | 13 | 16 | `packages/store/test/**`, `tests/store-hardening/**` | bajo |
| G-4 — `beforeEach` SQL `acl_edges/tenants/rooms/memberships` enable | 14 | 7 | `packages/store/test/**` | alto |
| G-5 — `apps/sockets` + `afterEach` cierra ambos (gateway-hardening) | 8 | 7 | `tests/gateway-hardening/**` | medio |
| G-6 — `function text(data: RawData): string` | 8 | 6 | `tests/gateway-hardening/**` | bajo |
| G-7 — `interface Consumer` + `async function consumer()` | 6 | 8 | `packages/store/test/**` | medio |
| G-8 — Helpers `shadowPhaseExists`/`consolePublishIndexesExist` | 4 (×8 fns) | 8 | `packages/store/test/**-migration-*.test.ts` | medio |
| G-9 — `apps` + `afterEach pop().close()` (services/gateway) | 5 | 5 | `services/gateway/src/*.test.ts` | bajo |
| G-10 — `function pool/fakePool()` con `vi.fn` | 8 | 3 | `tests/gateway-hardening/helpers.ts` + `services/gateway/src/*.test.ts` | alto |
| G-11 — Preámbulo `const repository = resolve(...)` | 13 | 6 | `tests/unit/**` | bajo |
| G-12 — `function sinComentarios(css)` | 6 | 3 | `console/src/**/*.test.{ts,tsx}` | bajo |
| G-13 — `function bloqueMedia(css, consulta)` (+ `declaraciones`, `valor`) | 4 (+ 5 + 5) | 18 | `console/src/**/*.test.{ts,tsx}` | medio |

**Total confirmado**: 13 grupos · ≈580 línea-ocurrencias duplicadas.

## Hogares únicos prioritarios (orden de intervención)

1. **`console/src/test/leer-css.ts`** — resuelve G-1 + G-12 (parcialmente G-13). Mayor ratio líneas/sitios.
2. **`console/src/test/css-parser.ts`** — resuelve G-13 + G-12 + G-1 (parcial). Segunda mayor ratio.
3. **`tests/helpers/postgres.ts` (extensión)** — `closeTestDatabase(database)` resuelve G-2 enteramente; tests de `packages/store/test/**` y `tests/store-hardening/**` lo importan.
4. **`tests/store-hardening/_fixtures/command.ts`** — resuelve G-3. Hogar único `packages/store/test/**` (Codex) por ser donde más se usa.
5. **`packages/store/test/_fixtures/enable-everything.ts`** — resuelve G-4. Sector Codex.
6. **`tests/gateway-hardening/helpers.ts` (extensión)** — `text(RawData)`, `gatewayApps`, `sockets`, `closeAllGateways()` resuelven G-5 + G-6.
7. **`packages/store/test/_fixtures/consumer.ts`** — resuelve G-7 + parte de G-3 y G-4.
8. **`packages/store/test/_fixtures/migration-phase.ts`** — resuelve G-8.
9. **`services/gateway/src/__test-helpers__/close-apps.ts`** + `services/gateway/src/__test-helpers__/pool.ts` — resuelven G-9 + G-10 (cross-zone; sector Codex por `services/gateway/src/**`).
10. **`tests/helpers/repository-root.ts`** — resuelve G-11.

## Conflictos de sector a coordinar

- **G-9 + G-10**: el hogar único cae en `services/gateway/src/**` (Codex), pero lo consumen `tests/gateway-hardening/**` (Gemini). Codex debe crear el helper y Gemini lo importa — sin que Gemini edite nada en `services/gateway/src/**`.
- **G-2 + G-3 + G-4 + G-7 + G-8**: el hogar vive en `tests/helpers/postgres.ts` (Gemini) o `packages/store/test/_fixtures/` (Codex). El reparto actual del protocolo lo deja claro: el `helpers/postgres.ts` ya exporta `startTestDatabase`/`resetTestDatabase`; extenderlo con `closeTestDatabase`/`enableEverything` es sector Gemini. Los nuevos `_fixtures/` dentro de `packages/store/test/` son sector Codex.
- **G-1 + G-12 + G-13**: hogar en `console/src/test/` (Gemini) — sin conflicto intersectorial.

## Cosas explícitamente descartadas (no son duplicación, o son helpers legítimos)

- **`renderWithApi(element, options)`** (1 declaración en `console/src/test/render.tsx:8` + 403 usos) — ya centralizado.
- **`function pool()` con `connect`/`idleClient`** en `services/dispatcher/test/liveness.test.ts:21-32` — caso único, no duplica nada.
- **`FakeTmux implements TmuxController`** en `packages/adapter-sdk/test/shared-session-turn-merge.test.ts:95` y `shared-session.test.ts:168` — misma intención, pero `shared-session.test.ts` añade 600 líneas de setup extra; un merge sería destructivo, no constructivo.
- **`class FakeHarness`** — usado en `tests/integration/vertical.test.ts` desde `@cauce/adapter-sdk` (ya exportado).
- **`bridge-fixtures.ts`** en `services/telegram-bridge/test/` (392 líneas, 9 exports) — ya centralizado, todos los tests del bridge lo importan.
- **Mocks `vi.fn` específicos** (cada test mockea funciones distintas) — no son duplicación.
- **Patrones `beforeEach` de tests postgres que NO usan `UPDATE acl_edges`** (algunos tests solo llaman `await resetTestDatabase(pool)` y luego INSERTs específicos) — no comparten bloque.
- **El bloque `let database; let pool; let repository;`** (declaración de variables, 3 líneas) — sale en 30+ tests, pero 3 líneas es el mínimo irreducible.
- **`describe`/`it`/`test`/`expect` boilerplate** — es la API del framework, no es duplicación.
