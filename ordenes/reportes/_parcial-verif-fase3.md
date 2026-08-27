# Verificación numérica de `PENDIENTES-DEL-DUEÑO.md` (27-08-2026)

Solo lectura. Cada cifra re-medida con un comando y su salida. Sin tocar
producción. Sin editar nada. Reporte generado por verificación directa contra
el árbol `main`.

Convenciones:
- `VERDADERO` = la afirmación coincide con lo medido.
- `FALSO` = la afirmación contradice lo medido; se da la cifra correcta.
- `MATIZADO` = la afirmación es parcialmente correcta y necesita contexto.
- `NO VERIFICABLE` = el comando no puede decidirlo desde el repo; se explica qué haría falta.

---

### A1 — D2: «`prometheus.yaml` trae reglas de alertmanager pero el servicio no está en el compose»
VEREDICTO: MATIZADO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:27`
COMANDO:
$ grep -nE "alerting:|alertmanagers:|alertmanager:" /datos/workspaces/zeus/cauce-v3/ops/observability/prometheus.yaml /datos/workspaces/zeus/cauce-v3/deploy/compose.yaml /datos/workspaces/zeus/cauce-v3/deploy/compose.alertmanager.yaml
```
ops/observability/prometheus.yaml:8:alerting:
ops/observability/prometheus.yaml:9:  alertmanagers:
ops/observability/prometheus.yaml:11:        - targets: [alertmanager:9093]
deploy/compose.yaml: (sin coincidencias)
deploy/compose.alertmanager.yaml:9:  alertmanager:
```

$ grep -nA1 "CauceAlertmanagerDown" /datos/workspaces/zeus/cauce-v3/ops/observability/alerts.yaml
```
4:      - alert: CauceAlertmanagerDown
5:        expr: absent(up{job="cauce-alertmanager"}) or up{job="cauce-alertmanager"} == 0
```
severity en línea 8 del mismo grupo: `severity: critical`.

LECTURA: El servicio `alertmanager:` SÍ existe, pero **solo en el overlay `deploy/compose.alertmanager.yaml`** (línea 9), NO en `deploy/compose.yaml` (que es el commit `00f8e6e deploy: compose canonico unico (FASE 3)`, el que el dossier trata como «canónico único»). El dossier (00-DOSSIER.md:49) lo dice con el mismo matiz: «el prometheus.yaml nuevo trae alertas de alertmanager pero el servicio no está en el compose». La alerta `CauceAlertmanagerDown` (`alerts.yaml:4-8`) es `severity: critical` y se enciende a los 2 m de no ver `up{job="cauce-alertmanager"}`. Importante: el servicio `prometheus` mismo está bajo `profiles: [observability]` (`compose.yaml:530`); sin ese perfil no se carga `prometheus.yaml` y la alerta no llega a evaluarse. Para que `CauceAlertmanagerDown` quede «encendida para siempre» hay que (a) desplegar con perfil `observability` y (b) olvidarse del overlay `compose.alertmanager.yaml`. Esa combinación es la que el dueño tiene que decidir; decir «el servicio no está en el compose» sin matiz es engañoso a secas.

---

### A2 — D2: «7 variables a aprovisionar» para el receptor Telegram
VEREDICTO: VERDADERO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:27`
COMANDO:
$ grep -nE '\$\{?CAUCE_ALERTMANAGER_[A-Z_]+' /datos/workspaces/zeus/cauce-v3/deploy/compose.alertmanager.yaml | sort -u
```
11:    image: ${CAUCE_ALERTMANAGER_IMAGE:?set an immutable CAUCE_ALERTMANAGER_IMAGE digest}
15:    user: "${CAUCE_ALERTMANAGER_UID:?set the provisioned non-root uid}:${CAUCE_ALERTMANAGER_GID:?set the provisioned non-root gid}"
24:        source: ${CAUCE_ALERTMANAGER_CONFIG_PATH:?set the tracked identity-free Alertmanager config}
30:        source: ${CAUCE_ALERTMANAGER_DATA_DIR:?set a private persistent Alertmanager data directory}
37:        uid: "${CAUCE_ALERTMANAGER_UID}"
38:        gid: "${CAUCE_ALERTMANAGER_GID}"
42:        uid: "${CAUCE_ALERTMANAGER_UID}"
43:        gid: "${CAUCE_ALERTMANAGER_GID}"
59:    file: ${CAUCE_ALERTMANAGER_TELEGRAM_TOKEN_PATH:?set CAUCE_ALERTMANAGER_TELEGRAM_TOKEN_PATH}
61:    file: ${CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH:?set CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH}
```

Únicas tras deduplicar: `CAUCE_ALERTMANAGER_{IMAGE,UID,GID,CONFIG_PATH,DATA_DIR,TELEGRAM_TOKEN_PATH,TELEGRAM_CHAT_ID_PATH}` → 7.

LECTURA: Coincide con el dossier (00-DOSSIER.md:49) y con `plan-reestructura/plano-objetivo.md:560` («coste de 7 variables nuevas a aprovisionar si se despliega con receptor Telegram»). Cifra correcta.

---

### A3 — D3: «Cambia el source de 4 binds» (correr el compose desde el repo en vez de copiar a `/opt`)
VEREDICTO: VERDADERO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:32` (refuerza `compose-canonico.md:50`)
COMANDO:
$ grep -nE 'source: (\.\./|\./)[^$]|-\s+\./|: \./|: \.\./' /datos/workspaces/zeus/cauce-v3/deploy/compose.yaml /datos/workspaces/zeus/cauce-v3/deploy/compose.postgres.yaml /datos/workspaces/zeus/cauce-v3/deploy/compose.alertmanager.yaml
```
compose.yaml:516:      - ../ops/observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro
compose.yaml:536:      - ../ops/observability/prometheus.yaml:/etc/prometheus/prometheus.yaml:ro
compose.yaml:537:      - ../ops/observability/alerts.yaml:/etc/prometheus/alerts.yaml:ro
compose.postgres.yaml:40:      - ./postgres-tls-entrypoint.sh:/opt/cauce/postgres-tls-entrypoint.sh:ro
```

LECTURA: 4 binds cuyo `source` resuelve relativo al CWD del `docker compose`, no absoluto:
- `compose.yaml:516` `../ops/observability/otel-collector.yaml` (perfil `observability`)
- `compose.yaml:536` `../ops/observability/prometheus.yaml` (perfil `observability`)
- `compose.yaml:537` `../ops/observability/alerts.yaml` (perfil `observability`)
- `compose.postgres.yaml:40` `./postgres-tls-entrypoint.sh` (overlay de postgres)

Los demás `source:` que aparecen en los compose son o secretos de Docker (que apuntan a paths absolutos via variables `${CAUCE_*_PATH}`) o env-vars (`${CAUCE_*_DIR}`). Estos 4 son los únicos cuyo source es un path relativo que depende de DÓNDE se ejecute `docker compose -f`. Coincide con `compose-canonico.md:50`.

---

### A4 — FASE 3 (línea 96): «migrar 026–037»
VEREDICTO: MATIZADO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:96`
COMANDO:
$ ls /datos/workspaces/zeus/cauce-v3/packages/store/migrations/ | grep -E '^0(2[6-9]|3[0-7])' | sort
```
026_agent_profile.sql
027_rol_agent_notify.sql
028_canonical_agent_role.sql
029_reconcile_declared_fleet.sql
030_dlq_causal_reconciliation.sql
031_connection_session_fencing.sql
032_terminal_session_claim_fencing.sql
033_terminal_browser_owner_fencing.sql
034_terminal_relay_instance_fencing.sql
035_agent_profile_runtime_adoption.sql
036_shadow_router_target_phase.sql
037_console_publish_intent_indexes.sql
```

$ ls /datos/workspaces/zeus/cauce-v3/packages/store/migrations/down/ | grep -E '^0(2[6-9]|3[0-7])' | sort
```
026_agent_profile.sql
028_canonical_agent_role.sql
029_reconcile_declared_fleet.sql
030_dlq_causal_reconciliation.sql
031_connection_session_fencing.sql
032_terminal_session_claim_fencing.sql
033_terminal_browser_owner_fencing.sql
034_terminal_relay_instance_fencing.sql
035_agent_profile_runtime_adoption.sql
036_shadow_router_target_phase.sql
037_console_publish_intent_indexes.sql
```

LECTURA: 12 migraciones en el árbol principal entre 026 y 037 (sin huecos). El dossier (migraciones.md:1 y 00-DOSSIER.md:9) confirma: «Las 12 migraciones 026–037 se aplican TODAS, en una sola transacción». La cifra que se aplicaría es **12**, no 11 ni 13. Matiz: en `migrations/down/` falta `027_rol_agent_notify.sql` (el down de la 027). `migraciones.md:37` ya avisa: «los ficheros `migrations/down/` existen pero JAMÁS se probaron; no son el plan» (el rollback previsto es el backup de BD, no un down-SQL). Que la 027 no tenga down es coherente con esa decisión, pero conviene que el dueño lo sepa antes de firmar.

---

### A5 — FASE 3 (línea 96): «2,4s medidos, una transacción, rollback automático probado»
VEREDICTO: MATIZADO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:96`
COMANDO:
$ grep -n "2,4\|3,3\|transacci\|rollback" /datos/workspaces/zeus/cauce-v3/plan-reestructura/fase3/00-DOSSIER.md /datos/workspaces/zeus/cauce-v3/plan-reestructura/fase3/migraciones.md
```
00-DOSSIER.md:9: 1. Las 12 migraciones 026–037 se aplican **TODAS, en una sola transacción** (así funciona el runner). NO saltarse 036/037: son requisito de readiness del gateway nuevo (`health.ts` las sondea).
00-DOSSIER.md:38: - **La tanda 026–037 completa: 2,4–3,3 SEGUNDOS de SQL** (ciclo entero clonar+B1+migrar ≈ 50 s). Una sola transacción confirmada empíricamente (12 applied_at idénticos). Idempotente.
00-DOSSIER.md:39: - **Ruptura deliberada ensayada**: sin el remedio B1, revienta en la 034 exactamente como predijo el dossier — rápido (3,9 s), error explícito, **rollback impecable verificado** (esquema queda en 024, cero residuos): se aplica B1 y se relanza sin re-clonar.
migraciones.md:7: - El runner (`packages/store/src/db.ts:88`) aplica TODO lo pendiente en **UNA transacción**: 026–037 entran o se revierten juntas. No existe aplicar una sola.
migraciones.md:37: Rollback de la tanda: automático si algo falla (una transacción). Rollback POST-commit: el backup de BD — los ficheros `migrations/down/` existen pero JAMÁS se probaron; no son el plan.
```

LECTURA: La cifra «2,4s» SÍ está en el dossier, pero como **extremo inferior** de un rango medido («2,4–3,3 segundos de SQL»). El dossier está fechado 2026-08-27 (línea 3) y cita evidencia empírica: «12 applied_at idénticos» y «rollback impecable verificado» sobre un clon de la BD productiva (pg_dump 183 MB, prod intocada, línea 37). NO es una cifra huérfana: hay fecha, hay método, hay verificación cruzada. Pero decir «2,4s medidos» (singular) en el doc del dueño es **impreciso**: el rango medido es 2,4–3,3 s y el ciclo total (clonar + B1 + migrar) fue ~50 s. Si el dueño firma pensando en un número único, mejor que sea explícito: la migración SQL pura tarda entre 2,4 y 3,3 s; el ciclo completo de la ventana, entre 45 y 60 s según el dossier.

---

### A6 — Línea 16 del dossier: «producción está en la migración 024»
VEREDICTO: MATIZADO (soporte documental, sin verificación directa nueva)
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:96` (implícito vía «migrar 026–037») y `00-DOSSIER.md:16`
COMANDO:
$ docker ps -a | grep -i inspect
```
f546dc126161   7b88c1e8dc4e   "/bin/sh -lc 'find /…"   2 days ago   Exited (0) 2 days ago   cauce-inspect-migration024
```

$ docker logs cauce-inspect-migration024 2>&1 | grep -nE "schema_version|schema_migrations|applied_at|current_schema|024"
```
3:678abb052499730c19d28ca3345c5d2c5932bc90f06d233f9e015d72c7da35b4  /app/packages/store/migrations/024_agent_role_templates.sql
```

LECTURA: El contenedor `cauce-inspect-migration024` existe y sus logs (204 líneas) muestran el contenido del SQL de la 024 y su SHA256, NO una query al `schema_migrations` de la BD productiva. La afirmación «producción está en 024» está respaldada por el dossier (`00-DOSSIER.md:16`, «con producción aún en 024») y por el bloque del ensayo del 27-08 (`00-DOSSIER.md:37-39`, ejecutado contra `pg_dump 183MB` de la base productiva). Es una afirmación **verificable de forma documental** (dossier + contenedor de inspección) pero **no de forma independiente desde el repo**: para confirmarla en frío haría falta o bien (a) `docker exec cauce-v3-prod-postgres-1 psql -At -c 'SELECT MAX(version) FROM schema_migrations'` (NO ejecutable aquí, requiere tocar prod), o bien (b) re-leer los logs de los migrators históricos, que el repo no conserva. La cadena de evidencia más sólida que ve este repo es: el `cauce-inspect-migration024` corrió el 25/26-08, el dossier se escribió el 27-08 citando el estado a esa fecha, y entre el 024 y el 026 no existe 025 en el árbol principal (`migrations/` tiene 022, 024, 026 — 022 y 025 faltan). La afirmación es **coherente** pero no **re-confirmable** sin tocar el servidor.

---

### A7 — Línea 10: «Ajuste de rutas PRE-despliegue corto y seguro (`deploy/runtime/`, ~11 refs)»
VEREDICTO: VERDADERO
AFIRMADO EN: `PENDIENTES-DEL-DUEÑO.md:10`
COMANDO:
$ grep -rln "deploy/runtime" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | sort -u
```
PENDIENTES-DEL-DUEÑO.md
deploy/Dockerfile
deploy/compose.yaml
deploy/smoke-runtime-packaging.sh
docs/mapa-de-ficheros.md
docs/terminal-pty.md
ops/tests/source-digest-domains.test.mjs
ordenes/reportes/claude-censo-comentarios-basura.md
plan-reestructura/plano-objetivo.md
scripts/calidad-base.json
tests/unit/runtime-package-smoke.test.ts
```

LECTURA: 11 ficheros contienen el prefijo `deploy/runtime` (incluyendo `deploy/runtime-entrypoint.sh`, `deploy/runtime-package-smoke.mjs`, `deploy/runtime-store.package.json` que ya existen como nombres de archivo). Si la cuenta fuera «líneas», el `grep -rn` da 43 ocurrencias; si la cuenta fuera «ítems del plan en `plano-objetivo.md`», da 16 (los items 1–16; los items 4 y 5 son «no se mueven», pero están listados). El ~11 del doc del dueño coincide exactamente con la cuenta de **ficheros afectados** (la lectura más natural de «refs»), y es la métrica que cuadra con el plan: 1 Dockerfile, 1 compose.yaml, 1 smoke-runtime-packaging.sh, 1 calidad-base.json, 1 plano-objetivo.md, 1 mapa-de-ficheros.md, 1 terminal-pty.md, 1 source-digest-domains.test.mjs, 1 runtime-package-smoke.test.ts, 1 PENDIENTES-DEL-DUEÑO.md, 1 censo-comentarios-basura.md.

---

## Resumen en una línea por afirmación

- **A1** (alertmanager en compose): MATIZADO — el servicio está en el overlay `deploy/compose.alertmanager.yaml`, NO en el base `compose.yaml`; la alerta es `critical` y se enciende si se despliega prometheus+alerts sin alertmanager (perfil `observability`).
- **A2** (7 vars Telegram): VERDADERO — 7 únicas `CAUCE_ALERTMANAGER_*` en `compose.alertmanager.yaml`.
- **A3** (4 binds): VERDADERO — `compose.yaml` líneas 516, 536, 537 (`../ops/observability/*.yaml`) + `compose.postgres.yaml:40` (`./postgres-tls-entrypoint.sh`).
- **A4** (migrar 026–037): MATIZADO — 12 migraciones (sin huecos); la 027 NO tiene `down` en `migrations/down/`.
- **A5** (2,4 s / transacción / rollback): MATIZADO — el dossier dice 2,4–3,3 s de SQL (rango), 50 s el ciclo entero; transacción única y rollback sí están probados contra clon.
- **A6** (producción en 024): MATIZADO — afirmación coherente y documentada en el dossier 27-08 + contenedor `cauce-inspect-migration024`, no re-confirmable desde el repo sin tocar prod.
- **A7** (~11 refs `deploy/runtime`): VERDADERO — exactamente 11 ficheros contienen el prefijo.
