# Pool de suscripciones IA y alta de <agent-05>/<agent-04> — plan ejecutable

**Estado:** propuesta de diseño + procedimiento. Nada de este documento fue ejecutado contra
producción; es un plan para una sesión de implementación posterior, explícitamente autorizada
para tocar código/DB/systemd. Este archivo es nuevo; no se modificó ni commiteó ningún otro
archivo del repo al producirlo.

## 0. Método y honestidad

Los 4 ángulos de diseño paralelos reportaron **9 intentos de delegación fallidos** en total
(codex/gpt-5.6-luna, codex/gpt-5.6-sol, gemini/pro, minimax) — todos colgados 1800s sin respuesta
del server MCP `cloud-offload`, no por falta de cuota (verificado con `get_ai_quotas` en al menos
dos de los ángulos). No reintenté una décima vez: la evidencia acumulada apunta a que el puente MCP
está degradado ahora mismo, no a un prompt específico. Este documento es síntesis directa,
verificada contra el código y la infraestructura real del repo (no contra los cuatro diseños "tal
cual" — donde discrepaban o especulaban de más, verifiqué en disco y me quedo con lo que el código
sostiene).

Antes de escribir concluí que había una corrección de premisa posterior al lanzamiento del
workflow (`CORRECCION-PREMISA.md`, leída primero, con prioridad explícita). La corrección cambia
sustancialmente el ángulo 4 de los cuatro diseños: **<private-project> no es un tenant nuevo**, es un
proyecto de <tenant-b>; <agent-05> y <agent-04> son agentes del tenant `<tenant-b>`/`grp.<tenant-b>` existente. Esto
invalida cualquier parte de los diseños que asumía alta de tenant.

Todo lo que sigue está verificado leyendo el código del repo (`packages/store/migrations/*.sql`,
`packages/store/src/{repository,configuration}.ts`, `packages/protocol/src/schemas.ts`,
`packages/adapter-sdk/src/{sdk,harnesses}/*.ts`, `ops/scripts/*.{py,sh}`,
`ops/container-aliases.json`, `ops/manifests/*.yaml`, `ops/schemas/alias-manifest.schema.json`,
`ops/runbooks/*.md`) en este mismo checkout, no repetido de memoria de los diseños previos.

---

## 1. El modelo definitivo del pool de suscripciones

### 1.1 Qué existe hoy en disco (verificado)

`packages/store/migrations/008_agent_and_account_registry.sql` existe pero está **sin commitear**
(`git status` lo lista como untracked). Crea `agents`, `provider_accounts`,
`agent_account_bindings` y hace backfill de los 12 alias vivos. **Cero código TypeScript lo
consume** (`grep` de `provider_accounts`/`agent_account_bindings` fuera de `packages/store/migrations`
no devuelve nada) y **no está en el camino crítico de entrega de mensajes**: `assertRuntimeRoute`
(`packages/store/src/repository.ts:2657-2674`) y `claimDeliveries`
(`packages/store/src/repository.ts:721-836`) leen `memberships` + `role_policies` + `tenants` +
`rooms` + `connection_leases`, nunca `agents`. Esto importa para el plan: **el pool de cuentas es
una capa aditiva sobre una ruta que ya funciona sin él**; nada de la Sección 4 (alta de <agent-05>/<agent-04>)
depende de que esta sección se implemente primero.

Bug real confirmado en el 008 sin commitear: `agent_account_bindings` tiene
`FOREIGN KEY (tenant_id, account_id) REFERENCES provider_accounts(tenant_id, id)` — un FK
compuesto que obliga a que la cuenta esté en el **mismo tenant** que el alias que la usa. Eso es
exactamente lo contrario de "todos pueden usar el pool de todos" (requisito literal de <tenant-a>).

**Colisión de numeración detectada** (más amplia de lo que reportó cualquiera de los 4 ángulos):
se observaron cuatro migraciones `008_*.sql` distintas entre el árbol principal y worktrees
privados. Los identificadores y paths de esos worktrees no se versionan; las colisiones eran:

```text
008_agent_and_account_registry.sql  (árbol principal)
008_agent_chain_visibility.sql       (fan-in, otra feature)
008_proactive_egress.sql             (otra feature)
008_agent_account_registry.sql       (mismo tema, nombre distinto)
```

El número que uso abajo (`009`) es **provisional**: quien mergee primero se queda con `008` (o el
número que corresponda) y todos los demás renumeran en su rebase. No asuman `009` como definitivo.

### 1.2 Entidades definitivas (fix del bug + cierre de las 3 objeciones abiertas)

**Recomendación de secuencia:** como `008` todavía no está commiteado, el camino más limpio es
editarlo *in place* antes del commit — no parchear con un `ALTER` posterior. Concretamente: dejar
en `008` sólo lo que ya es correcto (la tabla `agents`, líneas 12-55, y el seed de
`harness_definitions` para `openclaw`, líneas 7-10, que 003 nunca sembró), y mover
`provider_accounts`/`agent_account_bindings` — con la forma corregida de abajo — a un `009` nuevo.

```sql
-- 009_provider_account_pool.sql
-- Pool de cuentas compartible entre tenants. No toca el camino crítico de entrega
-- (claimDeliveries/assertRuntimeRoute no leen estas tablas todavía — ver §1.1).
SET LOCAL lock_timeout = '5s';

-- PK GLOBAL (no compuesta con tenant_id): este es el fix del bug de 008. Sin esto, un
-- agent_account_bindings de un tenant JAMÁS podría referenciar una cuenta de otro tenant,
-- y "pool compartido de todos" sería estructuralmente imposible.
CREATE TABLE IF NOT EXISTS provider_accounts (
  id text PRIMARY KEY,
  provider text NOT NULL,                    -- 'anthropic' | 'openai' | 'gemini' | 'minimax' | 'antigravity'
  external_account_id text NOT NULL,          -- identidad opaca (uuid/email), NUNCA el secreto
  payer_tenant_id text NOT NULL REFERENCES tenants(id),  -- quién paga; hoy esto NO existe en
                                                           -- ningún lado programático del sistema,
                                                           -- es información nueva a declarar a mano
  label text NOT NULL,
  credential_ref_kind text NOT NULL CHECK (credential_ref_kind IN ('env_path','file','secret_manager')),
  credential_ref text NOT NULL,               -- puntero (nombre de env var o ruta), nunca el valor
  shared_with_pool boolean NOT NULL DEFAULT false,   -- opt-in explícito a ser usada por OTROS tenants
  enabled boolean NOT NULL DEFAULT false,
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('healthy','degraded','failed','unknown')),
  health_checked_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_id_shape CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT provider_accounts_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  CONSTRAINT provider_accounts_credential_ref_shape CHECK (
    credential_ref !~ '[[:cntrl:]]' AND (
      (credential_ref_kind='env_path' AND credential_ref ~ '^CAUCE_[A-Z0-9_]{1,120}_(PATH|FILE)$')
      OR (credential_ref_kind='file' AND length(credential_ref) BETWEEN 2 AND 1024
          AND left(credential_ref,1)='/' AND credential_ref !~ '//'
          AND credential_ref !~ '(^|/)[.][.]?(/|$)')
      OR (credential_ref_kind='secret_manager' AND credential_ref ~ '^[a-z][a-z0-9_.:/-]{0,254}$')
    )
  ),
  UNIQUE (provider, external_account_id)
);

-- EL TECHO, hub-only: la única función de esta tabla es acotar qué cuentas puede llegar a usar
-- un alias. Cierra la objeción (a) de forma ESTRUCTURAL (FK de Postgres), no confiando en que
-- authorizeMutation sea "consciente de campos" (hoy no lo es, ver §1.3).
CREATE TABLE IF NOT EXISTS alias_routing_ceiling (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  account_id text NOT NULL REFERENCES provider_accounts(id),
  allowed_tiers text[] NOT NULL DEFAULT '{economy,standard,frontier}',
  created_by_tenant text NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias, account_id),
  CONSTRAINT alias_routing_ceiling_agent_fk
    FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias)
);

-- Orden de fallback DENTRO del techo. "purpose" (primary/fallback) del borrador 008 desaparece:
-- el "main" NUNCA es una fila de esta tabla (ver §1.4) — sólo candidatos de fallback viven acá,
-- así que un único valor de purpose era ruido.
CREATE TABLE IF NOT EXISTS agent_account_bindings (
  tenant_id text NOT NULL,
  agent_alias text NOT NULL,
  account_id text NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 32767),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_alias, account_id),
  -- Postgres RECHAZA estructuralmente cualquier binding fuera del techo, pase lo que pase en
  -- código de autorización: el FK apunta al techo, no directo a provider_accounts.
  CONSTRAINT agent_account_bindings_ceiling_fk
    FOREIGN KEY (tenant_id, agent_alias, account_id)
    REFERENCES alias_routing_ceiling (tenant_id, alias, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_account_bindings_order_idx
  ON agent_account_bindings (tenant_id, agent_alias, priority) WHERE enabled;

-- Cierra la objeción (b): fail-closed explícito por alias cuando no hay cuenta elegible.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS routing_account_required boolean NOT NULL DEFAULT false;
```

Doble compuerta default-off intacta: mientras `alias_routing_ceiling` esté vacía para un
`(tenant,alias)`, ese alias sigue exactamente como hoy — sin cuenta, sin cambio de comportamiento.

### 1.3 Cómo convive con el diseño de tier ya aprobado (por el cable va tier, nunca modelo)

- El "main del harness" **nunca** es una fila en `agent_account_bindings` ni una cuenta elegida
  dinámicamente. Es el intento `attempt=1` de una delivery, ejecutado **sin ningún override de
  entorno** (`CommandInvocation.env` queda `undefined`, exactamente el 100% de los casos hoy —
  verificado: `grep` de `CLAUDE_CONFIG_DIR`/`CODEX_HOME` en `ops/` y `packages/` no devuelve nada,
  nadie los usa todavía). El CLI resuelve su propia credencial ya logueada en el container. Esto
  es literalmente "fijo, no sale del pool": no hay forma de que Cauce le diga a `claude`/`codex`
  que use otra cuenta sin setear esa variable, y hoy nada la setea.
- `claimDeliveries` ya incrementa `attempt` en cada claim
  (`packages/store/src/repository.ts:781`, `attempt=d.attempt+1`) y ya reintenta vía
  `status='retry'` hasta `max_attempts` antes de pasar a `dead`. Esa maquinaria **existente** es el
  vehículo del fallback: intento 1 = main (sin override); intento 2+ = siguiente
  `agent_account_bindings` elegible por `priority`, filtrando `health_status != 'failed'`.
- El resultado de esa resolución **nunca viaja como un modelo concreto** por el wire — sigue
  siendo tier (`economy|standard|frontier`) más, cuando corresponda, un `account_id` opaco que el
  adapter usa sólo para construir el nombre de la env var (`credential_ref`), nunca el secreto.

### 1.4 Las 3 objeciones abiertas del diseño previo, cerradas

- **(a) alias_routing con alcance de tenant deja que el tenant restringido edite su propio
  techo** — cerrado estructuralmente por el FK de `agent_account_bindings` contra
  `alias_routing_ceiling` (§1.2): aunque `authorizeMutation` fuera ciego a campos, Postgres
  rechaza cualquier binding fuera del techo. Y en la práctica ni siquiera hace falta ese caso
  límite: verificado en `packages/store/src/configuration.ts:216-224`,
  `authorizeMutation` es **default-deny** — sólo abre self-service para
  `resource IN ('room','membership','acl_edge')`, matched contra el tenant del actor. Un
  `resource` nuevo (`provider_account`, `alias_routing_ceiling`, `agent_account_binding`) que
  **no** se agregue a esa lista queda hub-only automáticamente, sin escribir lógica nueva.
- **(b) account_required es inaplicable en los caminos fail-open** — cerrado con
  `agents.routing_account_required boolean DEFAULT false` (§1.2): si es `false` (default,
  idéntico a hoy) y no hay binding elegible, la delivery igual se reclama sin override
  (fail-open, prioriza disponibilidad). Si es `true` y no hay binding elegible, un predicado
  `WHERE` más en el `picked` CTE de `claimDeliveries` la deja fuera de ese ciclo — reintenta
  hasta agotar `max_attempts` y termina en `dead` vía el mecanismo **ya existente**, sin inventar
  un estado terminal nuevo.
- **(c) RequestedRoutingSchema .strict() hace fallar el parse en vez de descartar basura** —
  confirmado en vivo: `packages/protocol/src/schemas.ts` tiene 38 usos de `.strict()`, sin
  ninguna excepción hoy (líneas 251 y 247-249 para `DeliveryEnvelopeSchema`/`HttpAckSchema`
  incluidas). Cierre: agregar campos nuevos a un frame `.strict()` **tiene que ser un release
  separado y previo**, sin campos todavía, que sólo saca `.strict()` (Zod entonces hace
  strip silencioso de claves desconocidas por defecto). Desplegar y verificar 12/12 (con la
  misma disciplina documentada en evidencia privada de un rollout anterior)
  antes de agregar `routing_account_id`/`credential_ref` en un release posterior. Nunca los dos
  cambios en el mismo release: en una flota con 12+ adapters que no se reinician todos a la vez,
  un adapter viejo con `.strict()` todavía activo rompería el parse completo al ver una clave que
  no conoce.

### 1.5 Wiring de capability (patrón ya en producción, no headline nuevo)

`AdapterCapabilities` ya tiene el patrón de flags opcionales activados por harness
(`packages/adapter-sdk/src/sdk/types.ts:16-38`: `routing_targets_v1`/`renewable_delivery_claims_v1`
están en **true para los 12 alias** vía el helper compartido `capabilities()`
(`packages/adapter-sdk/src/harnesses/shared.ts:21-47`); `loopback_api`/`stable_alias_sessions`/
`api_cancellation` son las que sí varían por harness, inyectadas vía el parámetro `additions`
tipado `Pick<AdapterCapabilities, ...>`). Un futuro `provider_routing_v1?: true` sigue exactamente
ese segundo patrón: se agrega a la interfaz, se agrega a la lista de claves que acepta `additions`,
y se activa **sólo** en `claude.ts`/`codex.ts` (los dos únicos harnesses donde el mecanismo de
swap de cuenta por variable de entorno es técnicamente viable — ver §5). `openclaw.ts`, `hermes.ts`,
`opencode.ts` y `fake.ts` no lo tocan nunca: la compuerta queda cerrada por diseño para esos
harnesses, sin lógica condicional adicional.

### 1.6 Qué queda deliberadamente fuera de esta versión (no bloqueante para el alta de <agent-05>/<agent-04>)

Los ángulos 2 y 3 proponen capas más ambiciosas — salud de cuenta con poller activo, tabla de
consentimiento explícito de préstamo cross-tenant (`provider_account_pool_grants`), atribución de
uso con prorrateo por tokens (`delivery_usage`, `usage_rollup_hourly`). Son diseños razonables pero
**especulativos hoy**: ninguno tiene consumidor de código, y ninguno es necesario para que <agent-05> y
<agent-04> queden vivos (Sección 4). Los dejo fuera de la migración `009` a propósito, para no mezclar
"lo que hace falta para el alta de hoy" con "lo que hace falta para facturar por cliente en el
futuro". Cuando se retome: `provider_accounts.payer_tenant_id` (§1.2) ya es la única pieza de
atribución mínima necesaria para responder "quién paga esta cuenta"; una tabla insert-only tipo
`delivery_account_assignments(delivery_id, attempt, account_id, ...)`, poblada atómicamente en el
mismo `UPDATE...RETURNING` que ya hace el claim, es el punto de extensión natural el día que se
necesite evidencia dura por entrega — pero ese día no es hoy.

---

## 2. Tabla final de asignación — 12 vivos + <agent-05> + <agent-04> (14 alias)

`payer_tenant_id` no existe hoy en ningún registro programático (confirmado en §1.2): es
conocimiento tribal del operador. La columna de abajo es mi mejor lectura del inventario de
credenciales dado en el encargo, **no un hecho verificado en DB** — <tenant-a> debe confirmarla o
corregirla antes de que signifique algo para facturación real.

| alias | tenant | container | harness | cuenta que responde HOY (ambiente, sin override) | fallback en el pool | payer propuesto |
|---|---|---|---|---|---|---|
| <agent-07> | <tenant-a> | claw | openclaw | sin credencial Claude propia (accessToken vacío); enruta MiniMax/Antigravity dentro de `openclaw.json` | fuera de este pool (§5) | <tenant-a> |
| <agent-09> | <tenant-a> | ${INFRA_CONTROLLER} | hermes | `HERMES_INFERENCE_MODEL` fijado en el manifest de <agent-09>; cuál exactamente no fue re-verificado en esta pasada | fuera de este pool (§5) | <tenant-a> |
| <agent-01> | <tenant-a> | ${INFRA_CONTROLLER} | codex | ACCOUNT_EMAIL (única cuenta OpenAI del inventario) | ninguna otra cuenta Codex existe hoy | <tenant-a> |
| <agent-02> | <tenant-a> | ${AGENT_CONTAINER} | codex | ACCOUNT_EMAIL | ninguna | <tenant-a> |
| <agent-11> | <tenant-c> | agv2-<tenant-c>-personal-oc | openclaw | ChatGPT vía `openclaw.json` ("los personales de <tenant-c> van a ChatGPT", literal de <tenant-a>) | interno de openclaw, fuera de Cauce | <tenant-c> |
| <agent-12> | <tenant-c> | agv2-<tenant-c>-marcas-oc | openclaw | ChatGPT vía `openclaw.json` | interno de openclaw | <tenant-c> |
| <agent-13> | <tenant-c> | ${AGENT_CONTAINER} | codex | ACCOUNT_EMAIL (compartida) | ninguna | **<tenant-a>** paga la cuenta / **<tenant-c>** consume — pool compartido de facto, hoy sin registrar |
| <agent-15> | <tenant-c> | ${AGENT_CONTAINER} | claude | credencial Claude local del container; ninguna de las 2 cuentas Claude del inventario está explícitamente atada a <agent-15> — **no verificado en esta pasada** | ninguna | <tenant-c> (asumido, sin confirmar) |
| <agent-14> | <tenant-b> | claw-<tenant-b> | openclaw | ACCOUNT_EMAIL (recién logueada) + ChatGPT/MiniMax vía `openclaw.json` | interno de openclaw | <tenant-b> |
| <agent-10> | <tenant-d> | agv2-<tenant-d>-<agent-10>-oc | openclaw | ChatGPT vía `openclaw.json` | interno de openclaw | <tenant-d> |
| <agent-06> | <tenant-e> | ${AGENT_CONTAINER} | codex | ACCOUNT_EMAIL (compartida) | ninguna | **<tenant-a>** paga / **<tenant-e>** consume |
| <agent-03> | <tenant-b> | ${AGENT_CONTAINER} | **claude** (cambia de codex) | HOY ACCOUNT_EMAIL — verificado en vivo, pero es la cuenta personal de <tenant-a>, no de <tenant-b> (ver §4.9 sobre el bind-mount compartido) | ninguno definido en el MVP | **pendiente — ver §6** |
| **<agent-04>** (nuevo) | <tenant-b> | ${AGENT_CONTAINER} | **codex** | ACCOUNT_EMAIL — se suma al pool ya compartido de 4 alias | ninguna (única cuenta Codex) | **<tenant-a>** paga / **<tenant-b>** consume |
| **<agent-05>** (nuevo) | <tenant-b> | ${AGENT_CONTAINER} | **hermes** | `HERMES_INFERENCE_MODEL=gpt-5.6-sol` (decidido por <tenant-a>, mismo modelo que <agent-09>, "Codex es el proveedor con más saldo") | fuera de este pool — hermes tiene su propio selector, no pasa por env-swap | <tenant-b> (nominal; la cuenta real detrás de `gpt-5.6-sol` vía hermes no está documentada) |

Nota de lectura: "fallback" en esta tabla es **hoy**, con `alias_routing_ceiling` vacía para
los 14 (doble compuerta cerrada, comportamiento idéntico al actual). Nada de esta tabla activa el
pool — es un inventario de qué pasaría si se poblara, no una activación.

---

## 3. Procedimiento de alta de <agent-05> y <agent-04> + cutover de <agent-03>

### 3.0 Lo que <tenant-a> ya decidió y aplicó (no repetir, no cuestionar)

1. `tenant=<tenant-b>`, `room=grp.<tenant-b>` para <agent-05> y <agent-04> — **no se crea tenant**. El CHECK
   hub-star hardcodeado a `'<tenant-a>'` (`001_initial.sql:41`, viejo) ya fue reemplazado por el
   mecanismo data-driven `tenants.is_hub` + `cauce_assert_hub_star`
   (`004_runtime_gates.sql:15-60`, verificado) — y de todos modos no aplica: alta de `<agent-05>`/`<agent-04>`
   es un `INSERT INTO memberships` dentro de un tenant que ya existe, no toca `acl_edges`.
2. Repositorio `ultimate-terminal` (fuera de este repo) ya revertido a `ON CONFLICT DO NOTHING` +
   `RETIRED_AGENTS` eliminado — <agent-05>/<agent-04> ya no se auto-borran en cada boot de ese sistema.
3. `HERMES_INFERENCE_MODEL=gpt-5.6-sol` para <agent-05> — decidido, no abierto.
4. `<agent-05>=hermes` — decidido explícitamente para evitar colisión de `$HOME` con <agent-03>(claude)/
   <agent-04>(codex) en el mismo container (ver §3.9: con esta elección, la colisión **no ocurre**,
   porque los 3 harnesses tienen raíces de credencial por defecto distintas: `~/.claude`,
   `~/.codex`, `~/.hermes`).

### 3.1 Fase 0 — preflight (parcialmente hecho, falta formalizarlo)

Ya verificado en vivo (ángulo 4, ssh de sólo lectura): `claude` 2.1.220 y `codex` ambos instalados
en `${AGENT_CONTAINER}`; `${CREDENTIAL_FILE}` existe, no vacío, no expirado, cuenta
`ACCOUNT_EMAIL` (creada <private-timestamp>). El binario hermes ya está en
`${HARNESS_BINARY}`, pero **`~/.hermes` no existe todavía** en ese container. Esto
supera el bloqueo documentado en `ops/runbooks/container-adapters.md` ("El preflight live encontró
Claude sin autenticación") para `<agent-03>` — pero esa inspección ad hoc **no sustituye** el
preflight formal que el runbook exige para el release (comando exacto en §3.7).

### 3.2 Fase 1 — decisiones que sólo puede tomar <tenant-a> (bloquean todo lo demás)

1. **Cuenta Claude de <agent-03>**: ¿dejar `ACCOUNT_EMAIL` (la que ya está logueada) o
   re-loguear `${AGENT_CONTAINER}` con `ACCOUNT_EMAIL` (la que ya usa `<agent-14>`, mismo
   tenant)? Ver riesgo adicional en §3.9 antes de decidir — no es un simple re-login, ese
   directorio de credenciales está compartido por bind-mount con otros dos containers.
2. **Aceptar que `<agent-04>` se suma a la única cuenta Codex** (`ACCOUNT_EMAIL`),
   ya compartida hoy por <agent-01>/<agent-02>/<agent-06>/<agent-13> — no hay alternativa técnica sin dar de alta
   una segunda cuenta OpenAI.
3. **Emisión de certs mTLS** para <agent-05>/<agent-04>: no hay script de CA en este repo (`grep` vacío) — es
   un paso manual con la CA operativa, fuera de este repo.
4. **Bots Telegram nuevos** (BotFather) para <agent-05>/<agent-04> — manual, fuera de este repo.
5. **Autorizar la ejecución en producción** de las Fases 5-7 (systemd, DB, cutover) — este
   documento no las ejecuta (regla explícita del encargo: "no toques producción").

### 3.3 Fase 2 — repo (agente puede prepararlo; no toca producción)

Estos 5 archivos se validan por **igualdad exacta de conjunto de claves** entre sí — no se puede
tocar uno sin los otros:

1. `ops/scripts/manifest_lib.py` — `EXPECTED` (línea 14): agregar
   `"<agent-05>": ("<tenant-b>", "grp.<tenant-b>", "hermes")`, `"<agent-04>": ("<tenant-b>", "grp.<tenant-b>", "codex")`;
   cambiar `"<agent-03>": (...)` de `"codex"` a `"claude"`. También el mensaje de error de línea 69
   ("alias is not in the **12**-member fleet" → 14).
2. `ops/scripts/container_alias_lib.py` — `EXPECTED` (línea 11): mismo agregado/cambio, con
   `container='${AGENT_CONTAINER}', user='dev', home='${RUNTIME_HOME}'`,
   `stateDirectory='${RUNTIME_STATE_DIR},<agent-04>}'`.
3. `ops/schemas/alias-manifest.schema.json` — **no se toca**: `<tenant-b>`/`grp.<tenant-b>` ya están en
   los enums de `tenant`/`room` (líneas 22-23, verificado). Esto es una consecuencia directa de
   la corrección de premisa (no hay tenant nuevo).
4. `ops/manifests/<agent-05>.yaml`, `ops/manifests/<agent-04>.yaml` (nuevos, mismo shape que
   `ops/manifests/<agent-03>.yaml`); editar `ops/manifests/<agent-03>.yaml`: `harness: claude`. Para
   `<agent-05>`, el bloque `process` necesita la clave extra que sólo exige `hermes`
   (`manifest_lib.py:90`): `operationalModelEnv: HERMES_INFERENCE_MODEL` (valor literal exacto,
   validado por `manifest_lib.py:93`) además de `executablePathEnv: CAUCE_IZA_EXEC_PATH`.
5. `ops/container-aliases.json` — agregar bloques `<agent-05>`/`<agent-04>`; cambiar `<agent-03>.harness` a
   `"claude"`.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ops/scripts/validate-manifests.py
```

Literales `12` a subir a `14`, verificado de forma exhaustiva con
`grep -rn '\b12\b' ops/scripts/*.py ops/scripts/*.sh`:

```
ops/scripts/manifest_lib.py:69                        (mensaje de error, cosmético)
ops/scripts/validate-fleet-release-evidence.py:50,51,52,63,90
ops/scripts/release-candidate.py:148,149,185,186,219,223,268
ops/scripts/validate.sh:33,46,47
```
(`ops/scripts/generate-telegram-config.py` también menciona "12-alias fleet" en comentarios/
docstrings — líneas 8, 152, 157, 175, 744 — cosmético, no una aserción que rompa, pero conviene
actualizarlo por consistencia.)

### 3.4 Fase 3 — regenerar artefactos (nunca a mano)

```sh
python3 ops/scripts/generate-units.py --output ops/generated/systemd \
  && (cd ops/generated/systemd && sha256sum -c SHA256SUMS)
python3 ops/scripts/generate-container-units.py --output ops/generated/container-systemd \
  && (cd ops/generated/container-systemd && sha256sum -c SHA256SUMS)
python3 ops/scripts/container_ops_digest.py --check
bash ops/scripts/validate.sh
```
`validate.sh` regenera 14 units y compara contra lo commiteado — el diff de
`ops/generated/**` se commitea junto con el cambio de manifiestos.

### 3.5 Fase 4 — DB, sólo DML (008/009 de la Sección 1 son opcionales, ver abajo)

**Imprescindible** (esto es lo único que `assertRuntimeRoute`/`claimDeliveries` necesitan — §1.1):

```sql
INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES
  ('<tenant-b>','grp.<tenant-b>','<agent-05>','agent'),
  ('<tenant-b>','grp.<tenant-b>','<agent-04>','agent')
ON CONFLICT DO NOTHING;
-- <agent-03> no cambia fila: el harness no vive en memberships.
```
El rol `'agent'` ya existe en `role_policies` con `allow_route=true, allow_read=true`
(`003_adversarial_hardening.sql:61-64`, verificado) — no hace falta ninguna fila nueva ahí.

**Opcional, sólo si la Sección 1 (`agents`, migración `009`) ya se mergeó para cuando se ejecute
esta alta** — mantiene el registro informativo sincronizado, pero no bloquea nada si se omite:

```sql
UPDATE agents SET harness_id='claude', enabled=true, updated_at=now()
 WHERE tenant_id='<tenant-b>' AND alias='<agent-03>';

INSERT INTO agents(tenant_id, alias, harness_id, display_name, enabled,
                    container_name, runtime_user, home_directory, state_directory)
VALUES
  ('<tenant-b>','<agent-04>','codex','<agent-04>',true,'${AGENT_CONTAINER}','dev','${RUNTIME_HOME}',
   '${RUNTIME_STATE_DIR}'),
  ('<tenant-b>','<agent-05>','hermes','<agent-05>',true,'${AGENT_CONTAINER}','dev','${RUNTIME_HOME}',
   '${RUNTIME_STATE_DIR}')
ON CONFLICT (tenant_id, alias) DO NOTHING;
```

### 3.6 Fase 5 — secretos fuera de repo (manual, <tenant-a> u operador con la CA)

1. PKI: `~/.config/cauce-v3/container-pki/{<agent-05>,<agent-04>}/` en `0700`, con `client.crt`/`client.key`/
   `ca.crt` `0600` emitidos por la CA operativa (sin script en este repo — brecha documental real,
   no hay automatización de emisión de certs acá).
2. Dos entradas nuevas en `CAUCE_MTLS_IDENTITY_FILE` (fuera de repo, formato documentado en
   `ops/runbooks/authentication.md:63`): `{"certificate_sha256": "...", "principal": {"tenant_id":
   "<tenant-b>", "alias": "<agent-05>"|"<agent-04>", "channel": "adapter", "roles": [...]}}`.
   Publicar por rename atómico y **verificar que el gateway lo vea**: el registro se alcanza por el
   directorio montado `CAUCE_GATEWAY_IDENTITY_DIR` → `/run/cauce-identities`, y si alguna vez vuelve
   a montarse como archivo suelto el rename queda pinneado al inodo viejo y el alta no llega (falla
   como `mTLS certificate is not provisioned`, que el SDK enmascara como `FRAME_BEFORE_HELLO`).
   Comparar inodo/tamaño/mtime/conteo host vs. contenedor según
   `ops/runbooks/authentication.md` § "Montaje de los registros".
3. Bots Telegram nuevos vía BotFather (manual) + tokens `0600`, luego regenerar:
   `python3 ops/scripts/generate-telegram-config.py`.
4. `~/.config/cauce-v3/container-aliases/{<agent-05>,<agent-04>}.env` desde los `.env.example` regenerados en
   Fase 3, completando `BUNDLE_RELEASE`/`BUNDLE_SHA256`/`PKI_DIR`/`RELAY_URL`/`EXPECTED_IMAGE_ID`.
5. Para `<agent-05>` específicamente, además: crear `~/.hermes/profiles/<agent-05>` dentro de `${AGENT_CONTAINER}`
   (hoy `~/.hermes` no existe ahí — verificado). **Antes de clonarlo**, leer de sólo-lectura qué
   contiene `~/.hermes/profiles/<agent-09>` en `${INFRA_CONTROLLER}` (el único perfil hermes vivo hoy) para
   saber qué replicar — no asumido en este documento, no verificado en esta pasada:
   ```sh
   docker exec ${INFRA_CONTROLLER} find ${RUNTIME_HOME} -maxdepth 2
   ```
   y fijar en el `.env` de `<agent-05>`: `HERMES_HOME=${HARNESS_HOME}`,
   `HERMES_INFERENCE_MODEL=gpt-5.6-sol`. `HERMES_PYTHON` es opcional
   (`container-adapter-supervisor.sh:180-196`, verificado) — sólo fijarlo si el `.env` de <agent-09> lo
   usa, con una ruta bajo `${RUNTIME_HOME}` (nunca fuera del home mapeado).

### 3.7 Fase 6 — arranque (producción — requiere autorización explícita, no ejecutado acá)

```sh
python3 ops/scripts/generate-container-units.py --rootless --home "$HOME" \
  --output ops/generated/container-systemd/rootless
(cd ops/generated/container-systemd/rootless && sha256sum -c SHA256SUMS)
install -m 0644 ops/generated/container-systemd/rootless/cauce-v3-container-{<agent-05>,<agent-04>}.service \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now cauce-v3-container-<agent-05>.service cauce-v3-container-<agent-04>.service
ops/scripts/container-adapter-supervisor.sh check <agent-05>
ops/scripts/container-adapter-supervisor.sh check <agent-04>
```

`<agent-03>` **no** es un simple restart: es un cambio de harness, y el runbook lo prohíbe
explícitamente como edición suelta — cita literal verificada de
`ops/runbooks/container-adapters.md:50-51`: *"Volver cualquiera de esos tres alias a Claude
requiere un preflight live nuevo... y un nuevo release inmutable de ops con mapping, manifiesto,
units, digests y evidencia de flota regenerados; no se permite editar sólo la config o la unit
instalada."* Esa frase describe exactamente esta operación (<agent-03> volviendo a Claude tras el
cutover anterior a Codex) — no es una inferencia, es el runbook existente anticipando este
caso:

```sh
CAUCE_CHANGE_ID=CHG-xxxx \
CAUCE_CUTOVER_CONFIRM=cutover:container:<agent-03>:CHG-xxxx \
CAUCE_SYSTEMD_SCOPE=user \
ops/scripts/cutover.sh container <agent-03> snapshot-drain.json
ops/scripts/container-adapter-supervisor.sh check <agent-03>
```

### 3.8 Fase 7 — verificación (no basta `is-active`)

```sh
bash ops/scripts/validate.sh
python3 ops/scripts/validate-fleet-release-evidence.py
node ops/tests/container-supervisor.test.mjs
systemctl --user status cauce-v3-container-{<agent-05>,<agent-04>,<agent-03>}.service
journalctl --user -u cauce-v3-container-<agent-05>.service --since -10m
```
Más un round-trip real por Telegram (mensaje → delivery `done`) por cada uno de los 3 alias
tocados — exigido literalmente por el runbook, `is-active`/`check` solos no prueban que el harness
responda.

### 3.9 Riesgo específico verificado: la credencial `.claude` de <agent-03> NO es exclusiva de <tenant-b>

Del inventario de credenciales del encargo: *"/datos/agents/shared/.claude está montado idéntico
en ${INFRA_CONTROLLER}, ${AGENT_CONTAINER} y ${AGENT_CONTAINER} => <agent-09>, <agent-01>, <agent-02> y <agent-03> comparten literalmente
el mismo archivo."* Esto es clave para la decisión de §3.2.1: si `<agent-03>` pasa a `harness=claude`
y usa lo que hay en ese directorio, **no es una cuenta propia de <tenant-b>** — es el mismo archivo
físico que ven `${INFRA_CONTROLLER}` (<tenant-a>: <agent-09>, <agent-01>) y `${AGENT_CONTAINER}` (<tenant-a>: <agent-02>), aunque hoy
ninguno de esos otros tres alias usa realmente `harness=claude` (usan hermes/codex/codex, así que
no lo leen activamente). Por eso la cuenta que aparece logueada es la personal de <tenant-a>
(`ACCOUNT_EMAIL`) y no una de <tenant-b>: es tribalmente "la de quien la logueó por última
vez en ese bind compartido", no algo que Cauce aísle por alias. Consecuencias:

- Re-loguear `${AGENT_CONTAINER}` con `ACCOUNT_EMAIL` para "corregir" la atribución de
  `<agent-03>` **cambiaría el mismo archivo que comparten ${INFRA_CONTROLLER} y ${AGENT_CONTAINER}** — hoy inofensivo
  porque ningún alias activo ahí usa `harness=claude`, pero es un riesgo latente para el día que
  alguno lo use.
- La verdadera solución (aislar por alias con `CLAUDE_CONFIG_DIR`) es exactamente el mecanismo de
  §1.5/§5, hoy sin wiring en `ops/` (confirmado por `grep` vacío). Mientras no se construya, este
  bind compartido es una limitación de infraestructura preexistente, no algo que el pool de la
  Sección 1 resuelva por sí solo.
- Nota de calendario del propio inventario: la credencial compartida "vence hoy ~<private-time>" — no
  tengo forma de verificar si ese plazo ya pasó al momento de ejecutar este plan; quien lo ejecute
  debe revalidar el estado de la credencial antes de la Fase 3.2.1, no asumir que sigue vigente.

---

## 4. Fuera de alcance por el límite harness ≠ proveedor (sin ambigüedad)

- **`codex` sólo habla con OpenAI. `claude` sólo habla con Anthropic.** Ninguna fila de
  `agent_account_bindings`, por más pool que exista, hace que `<agent-04>` (harness `codex`) le hable a
  Anthropic ni que `<agent-03>`/`<agent-15>` (harness `claude`) le hablen a OpenAI. El pool cambia de
  **cuenta**, nunca de **proveedor**. "<tenant-e> usa Claude" o "<tenant-c> es Codex" son etiquetas de negocio
  que sólo se activan en el alias cuyo harness ya coincide con ese proveedor — nunca migran el
  harness de un alias existente. Con el inventario dado, "<tenant-e> usa Claude" no tiene hoy ningún
  correlato real (ninguna de las 2 cuentas Claude está asociada a <tenant-e>) hasta que <tenant-e> tenga un
  alias `harness=claude` propio o el hub decida que una cuenta Claude pagada por <tenant-e> entre al
  `alias_routing_ceiling` de otro alias claude existente (p. ej. `<agent-15>`) como fallback.
- **`openclaw` queda 100% fuera del mecanismo de la Sección 1**, no por decisión de producto sino
  por límite técnico verificado: `provider_routing_v1` (§1.5) nunca se activa en `openclaw.ts`, así
  que `connection_leases.capabilities` para <agent-07>/<agent-11>/<agent-12>/<agent-14>/<agent-10> jamás incluye esa
  capability y `claimDeliveries` nunca intenta resolución de cuenta para ellos. Su historia
  multi-proveedor (MiniMax/Antigravity/ChatGPT) ya la resuelve `openclaw.json`, **fuera** de este
  repo y de este control plane. Intentar meterla en el mismo pool exigiría pasar API keys (tipo
  `MINIMAX_API_KEY`) por `CommandInvocation.env` — y el regex `SECRET_ENVIRONMENT`
  (`packages/adapter-sdk/src/sdk/process-runner.ts:26`) **rechaza** cualquier nombre de variable
  que matchee `api[_-]?key` (verificado: `MINIMAX_API_KEY` matchea), así que ese camino ni
  siquiera compila hoy sin cambiar el filtro — sería una feature distinta, no una extensión de
  este diseño.
- **`hermes` (<agent-09>, <agent-05>) queda fuera por un motivo distinto: ya tiene su propio selector.**
  `HERMES_INFERENCE_MODEL` (allowlisteado en `SAFE_ENVIRONMENT`,
  `process-runner.ts:21-22`) es un mecanismo de ruteo de **modelo** que ya existe y ya funciona,
  orthogonal a las tablas de la Sección 1. No es que hermes esté bloqueado — es que ya resuelve
  esto por su cuenta y agregarlo al pool sería duplicar, no extender.
- **El mecanismo de swap de cuenta por variable de entorno
  (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) es viable sólo para `claude` y `codex`**, y hoy **no está
  wireado en ningún lado de `ops/`**: el allowlist de claves de
  `container-adapter-supervisor.sh:113-115` no incluye esas dos variables, y
  `ops/container-runtime/cauce-container-runtime.py:run_adapter` lanza el proceso hijo con
  `subprocess.Popen(..., env=None)` — es decir hereda el entorno del controlador tal cual, sin
  fijar `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` por alias. Construir ese wiring es trabajo de
  código previo (nuevo `case` en el allowlist + paso de `env` en `run_adapter`), no cosmético, y
  **no bloquea la alta de <agent-05>/<agent-04>** (§3) porque, con la asignación de harnesses que decidió
  <tenant-a> — `<agent-03>=claude`, `<agent-04>=codex`, `<agent-05>=hermes` — los tres usan raíces de credencial por
  defecto distintas (`~/.claude`, `~/.codex`, `~/.hermes`) dentro del mismo `$HOME` de
  `${AGENT_CONTAINER}`, así que **no hay colisión real para esta composición específica de equipo**. Sí
  sería bloqueante el día que un cuarto alias con `harness=claude` (o un segundo `codex`) quiera
  convivir en el mismo container con una cuenta distinta.
- El servidor **nunca** conoce ni transmite el valor real de una credencial — sólo nombres de
  variable de entorno (`credential_ref`) que el propio adapter resuelve leyendo su
  `process.env`, poblado únicamente por el `.env` allowlisteado del supervisor systemd de ese
  container específico. Si esa variable no está en el `.env` del container, el pool para ese alias
  es inerte aunque exista la fila en `provider_accounts` — límite operativo real, no sólo de
  datos.

---

## 5. Decisiones abiertas para <tenant-a> (resumen accionable)

1. **Cuenta Claude de `<agent-03>`**: ¿dejar `ACCOUNT_EMAIL` o re-loguear a
   `ACCOUNT_EMAIL`? Ver el riesgo de bind compartido en §3.9 antes de decidir — no es
   un simple re-login aislado.
2. **`payer_tenant_id` real** de cada `provider_accounts` (Sección 2): mi lectura del inventario es
   una inferencia razonable, no un hecho de facturación confirmado — en particular
   `<agent-13>`/`<agent-06>`/`<agent-04>` (Codex) y potencialmente `<agent-03>` (Claude) son casos de "<tenant-a> paga,
   otro tenant consume" que hoy nadie registra en ningún lado.
3. **¿Se implementa la Sección 1 (pool/migración `009`) ahora o se pospone?** No bloquea la alta de
   <agent-05>/<agent-04> (§1.1) — es una decisión de secuencia de trabajo, no de negocio.
4. **Numeración de migración**: 4 archivos `008_*.sql` compiten hoy entre worktrees (§1.1) — quien
   mergee primero fija el número real; este documento usa `009` como placeholder.
5. **Emisión de certs mTLS y bots Telegram para <agent-05>/<agent-04>**: pasos manuales sin automatización en
   este repo — ejecutarlos o encargar que se escriba el tooling faltante primero.
6. **Ejecución en producción de las Fases 5-7 de la Sección 3**: este documento las deja
   completamente especificadas pero **no ejecutadas**, por regla explícita del encargo.
