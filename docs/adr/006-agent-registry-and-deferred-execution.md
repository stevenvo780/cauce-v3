# ADR-006: registro de agentes, pool de suscripciones cross-tenant, y ejecución remota diferida

**Estado:** parcialmente implementado. La parte de datos/configuración (esta entrega) está aceptada;
la parte de ejecución remota en kratos es **diseño únicamente, no implementado**.

Este ADR fija la forma acordada en `plan-reestructura/` (el plan operativo de la fase en vuelo:
inventario de alias, fases de alta de iza/atlas). El doc histórico `POOL-SUSCRIPCIONES-Y-ALTA-AGENTES`
ya no está en el árbol (`find docs/ -name 'POOL-*'` → 0 resultados); este ADR es ahora la decisión
de arquitectura y lo que efectivamente quedó en el código.

## Decisión central: la cuenta no pertenece a quien la usa, pertenece a quien la paga

El borrador anterior de esta migración tenía `agent_account_bindings` con
`FOREIGN KEY (tenant_id, account_id) REFERENCES provider_accounts(tenant_id, id)`. Ese FK compuesto
obligaba a que la cuenta viviera en el **mismo tenant** que el alias que la usa, es decir hacía
**estructuralmente imposible** el requisito literal del operador: "todos pueden usar el pool de
todos". Se descartó.

El modelo que lo reemplaza:

- **`provider_accounts` tiene PK global (`id`), no compuesta con ningún tenant.** Una suscripción es
  un objeto por derecho propio. Quién paga se conserva en `payer_tenant_id`, que es información
  nueva y explícita: hoy no existe en ningún otro lado programático del sistema.
  `UNIQUE (provider, external_account_id)` garantiza que una misma suscripción externa no se
  registre dos veces con dos pagadores distintos, que es justo lo que haría irrespondible
  "quién paga qué".
- **`shared_with_pool` es el consentimiento del pagador**, default-deny como cualquier otro permiso
  de este esquema. Prestar una cuenta no se decide en el tenant que la consume.
- **`alias_routing_ceiling` es el techo por alias**: el conjunto exhaustivo de cuentas a las que un
  alias puede llegar a rutearse. `agent_account_bindings` referencia el techo, **no**
  `provider_accounts`, así que ningún binding fuera del techo puede existir aunque la capa de
  autorización cambiara.
- **`agent_account_bindings` es sólo el orden de fallback dentro del techo** (`priority`, menor
  primero). No tiene columna `purpose`: ver más abajo.

### Por qué el consentimiento del pagador lo enforcea Postgres y no el código

`alias_routing_ceiling` guarda `account_payer_tenant`, un espejo del pagador que un FK contra
`provider_accounts(id, payer_tenant_id)` mantiene verdadero. De ahí salen dos columnas generadas
(`borrowed_payer_tenant`, `borrowed_from_pool`) que son no-nulas **exactamente** cuando la fila
presta la cuenta de otro tenant, y un segundo FK contra
`provider_accounts(id, payer_tenant_id, shared_with_pool)`. Bajo `MATCH SIMPLE` un FK con alguna
columna nula no se verifica, así que el guard aplica sólo a los préstamos y deja intacto el caso
"el pagador rutea su propia cuenta". Consecuencias, ambas cubiertas por test:

- No se puede crear un techo hacia una cuenta ajena que su pagador no publicó al pool (23503).
- No se puede sacar del pool una cuenta que otro tenant todavía tiene en su techo (23503): revocar
  exige borrar primero el techo, que a su vez cascadea el binding. La revocación nunca queda a
  medias ni depende del orden en que el operador haga las cosas.

Se eligió columna generada en vez de un espejo escrito por la aplicación porque un espejo escrito
por código puede desincronizarse; uno generado no. Éste es el límite que decide **con la plata de
quién** se ejecuta una delivery: no es un invariante para dejar en la capa de aplicación.

### Por qué desapareció `purpose` (primary/fallback) y qué significa "excepto en el main del harness"

El requisito literal era "todos pueden usar el pool de todos **excepto en el main del harness**". No
se modela como una fila con `purpose='harness_main'`: el main del harness **no es una fila de
ninguna de estas tablas**. El intento 1 de una delivery corre sin ningún override de entorno, así
que el CLI (`claude`, `codex`, …) resuelve la credencial que ya tiene logueada dentro de su
container. Con un único valor posible, `purpose` era ruido. El pool sólo puede intervenir en los
reintentos, que es exactamente donde el requisito lo permite.

### Credenciales

`credential_ref` es siempre un locator — nombre de variable de entorno, ruta absoluta, o
`esquema:path` de un secret manager — nunca el secreto; su forma se valida con un CHECK por
`credential_ref_kind`. El gateway no lo resuelve nunca: eso queda host-side, igual que `PKI_ROOT`
hoy. **Esto es lo que hace seguro prestar una cuenta**: el prestatario recibe una referencia que
sólo puede dereferenciar en un host que ya tiene el material.

`provider`, `external_account_id`, `payer_tenant_id` y el locator son inmutables después del create:
rotar es delete+create. Un `id` de cuenta está referenciado desde el techo, así que repuntarlo en
silencio cambiaría retroactivamente qué significa cada préstamo existente.

`GET /v3/console/config` nunca devuelve `credential_ref`, ni siquiera a su pagador. Y para un tenant
no-hub, una cuenta ajena publicada al pool se ve reducida a su forma (quién paga, qué proveedor, su
label): `external_account_id` y `credential_ref_kind` describen material del pagador y se anulan.
`GET /v3/console/agents/:alias` aplica la misma regla sobre `routing_accounts`.

### Autorización

Los cuatro resources nuevos de `ConfigMutation` (`agent`, `provider_account`,
`alias_routing_ceiling`, `agent_account_binding`) **no** se agregaron a la lista de self-service de
`authorizeMutation`, así que quedan hub-only por el default-deny que ya existía — sin lógica nueva y
sin una regla que un edit futuro pueda ablandar por descuido. Prestar una suscripción es una
decisión sobre la plata de otro; no es self-service.

Todo entra por `POST /v3/console/config/changes`, con el mismo motor de dry-run / revisión optimista
/ auditoría / rollback que ya usan tenant/room/membership/acl_edge/harness/role_policy/chain_policy/
egress_destination. No hay ruta de escritura nueva.

### Lecturas

`GET /v3/console/agents` y `GET /v3/console/agents/:alias` (`repository/agents.ts`: `listAgents`/`getAgent` desde la extracción de la fachada de 11K → 42 líneas)
filtran por el mismo criterio que `topology()`/`listMessages()`/`queueSnapshot()` — tenant propio más
cualquier tenant con `acl_edge.allow_read` desde el actor — para no introducir un segundo modelo de
visibilidad. `deployment_status` (`disabled`/`unknown`/`online`/`offline`) se deriva sólo de
`agents.enabled` + `connection_leases`: es honesto sobre lo que Postgres sabe hoy y no simula un
estado de contenedor que nadie reporta.

### Qué se dejó fuera a propósito

- **`health_status` / `health_checked_at` / `consecutive_failures`** en `provider_accounts`
  (§1.2 del plan): no hay poller ni ningún otro escritor. Una columna que nadie escribe es una
  mentira en el esquema; entra el día que entre su consumidor.
- **`agents.routing_account_required`** (§1.4b): su único efecto sería un predicado extra en el CTE
  `picked` de `claimDeliveries`, que no está en esta entrega. La columna sola no hace nada.
- **`allowed_tiers`** en el techo: el concepto de tier todavía no existe en `packages/protocol`.
- **Partir la migración en dos** (`008` + `009`, como sugería el plan): quedó sin efecto. Ninguno de
  los dos archivos llegó a commitearse, y `008`/`009` los tomaron agent-chain-visibility y
  proactive-egress —ambos ya aplicados en producción e inmutables—, así que todo esto aterriza junto
  como `010_agent_account_registry.sql`.
- **Atribución de uso** (`delivery_account_assignments`, prorrateo por tokens): `payer_tenant_id` es
  la pieza mínima para responder "quién paga esta cuenta"; facturar por cliente es otra entrega.

## Diferido: ejecución remota en kratos (systemd/docker)

Fuera de esta entrega, sin implementar: nada en este cambio abre una ruta de ejecución hacia kratos.
`agents`/`provider_accounts` son intención declarada en Postgres; el contenedor/unit/PKI real sigue
siendo 100% manual (`ops/scripts/manifest_lib.py` y `container_alias_lib.py` con sus diccionarios
`EXPECTED` hardcodeados) hasta que exista una segunda fase explícita. Diseño para esa fase, a
decidir/construir después:

- **No** exponer un servicio HTTP entrante nuevo en kratos, ni SSH `command=` desde el gateway: ambos
  abren superficie de ejecución de código nueva y duplican PKI/auditoría que el bus ya resuelve.
- Patrón preferido: un "ops-executor" en kratos como una unidad systemd más, con su propia identidad
  mTLS **saliente** (mismo patrón que los 12 adapters de producción), recibiendo un verbo de un
  conjunto cerrado (`unit.start|stop|check`, `bundle.pin|rollback`) como delivery del bus hacia un
  tenant/alias reservado — mapeado 1:1 a argv fijo de `container-adapter-supervisor.sh` y
  `pin-container-release.py` (los dos scripts ya hardened con CAS real), nunca a un string ejecutado
  en un shell.
- Un `agents` habilitado en Postgres describe una intención; sincronizarlo con
  `ops/container-aliases.json` (o reemplazar ese archivo) requiere un paso de reconciliación
  humano/CI-gateado explícito — automatizarlo sin ese paso sería abrir ejecución remota de código no
  revisada sobre producción.
- Mientras esta fase no exista, dos fuentes de verdad coexisten a propósito: Postgres (intención) y
  los diccionarios `EXPECTED` (ejecución real). `GET /v3/console/agents` debe seguir mostrando ambas
  señales por separado (registro vs. presencia) para no inducir a un operador a creer que un agente
  "dado de alta" en Postgres ya tiene contenedor corriendo.
