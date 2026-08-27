# PENDIENTES DEL DUEÑO — la única página que necesitas leer

Consolidado de todo lo que **solo Steven puede decidir** para destrabar el proyecto.
Cada item es una decisión concreta: el checkbox es la aprobación; el link es la lectura detallada.

---

## (1) Decisiones D1–D5 del dossier FASE 3 — el despliegue no arranca sin estas

- [ ] **D1 — Flota de la 029 (ENSAYADA contra un clon de tu base — es decisión DOBLE)**: (a) deshabilita 3: `Jhon/heraclito`, `Jhon/tales`, `Miguel/gaia`; y (b) **DA DE ALTA los 4 agentes de Pablo**: `dedalo` (codex), `midas` y `seneca` (openclaw), `vulcano` (claude) — flota 14→18, 15 enabled. Los 4 de Pablo nacen sin perfil (no rompe; no publican perfil hasta dárselo). ¿Aplicar tal cual, o editar la lista del SQL antes?  → ensayo en `plan-reestructura/fase3/00-DOSSIER.md` §Ensayo
- [ ] **D2 — Alertmanager**: el `prometheus.yaml` nuevo declara reglas de alertmanager pero el servicio no está en el compose. ¿Se despliega con receptor Telegram (7 variables nuevas a aprovisionar) o se recortan esas reglas? Sin decidir, `CauceAlertmanagerDown` queda critical encendida para siempre.  → `plan-reestructura/fase3/compose-canonico.md` §6
- [ ] **D3 — Origen del compose**: ¿desde el repo (`/datos/workspaces/zeus/cauce-v3`) o se sigue copiando a `/opt`? Cambia el source de 4 binds. Recomendación: desde el repo — una sola fuente.  → `plan-reestructura/fase3/compose-canonico.md` §5
- [ ] **D4 — Bloque B de pty-huérfanos** (heraclito/tales, churn cero, alias ya fuera del mapa): ¿se matan también? Son 2 de los 12 del kill-list.  → `plan-reestructura/fase3/pty-huerfanos.md`
- [ ] **D5 — Censo de huérfanos en el OTRO host**: el bucle de `dedalo`/`salva` viene de otra máquina; hace falta el mismo censo allí. ¿Cuándo?  → `plan-reestructura/fase3/pty-huerfanos.md`

---

## (2) Dudosos restantes del censo (45 → residuo, agrupados por decisión)

Resueltos en rondas 6/7 (historial en git): 29 confirmados + 80 piezas más del censo borradas en `73e533c`. Lo que queda:

- [ ] **(a) Herramientas de otras máquinas** — `ops/cli/cauce-portatil`, `ops/cli/compilar-en-torre`: pensadas para el portátil del operador y la torre de compilación; cero uso en zeus. ¿Se borran, se mueven a bitácora, o se conservan como referencia?  → `plan-reestructura/censo-contingentes.md` §a
- [ ] **(b) Familia DLQ manual** — `ops/scripts/dlq_cli.py` + 5 wrappers (`dlq-list`, `dlq-reconcile`, `resolve-dlq-without-replay`, `telegram-manual-replay`, `telegram-replay-inspect`) + 3 schemas vivos en `ops/schemas/`. Herramientas de emergencia del operador, sin runner automático. ¿Se quedan vivas o se documentan en bitácora?  → `plan-reestructura/censo-contingentes.md` §b
- [ ] **(c) Console-legibilidad** — 6 ficheros en `ops/console-legibilidad/` (CDP, medir, probe, servir-con-csp): tooling de medición sin integración, ni CI. ¿Se archivan o se mantienen como herramientas vivas?  → `plan-reestructura/censo-contingentes.md` §c
- [ ] **(d) Quota-collector** — `ops/scripts/quota-collector.py` + 2 plantillas + 2 scripts de backup de `ut-nexus` (corre en otra máquina) + 5 tests/fixtures sin runner. Override explícito del integrador: la base escribe muestras, falta decidir quién colecta. ¿Se mueve, se conecta, o se espera?  → `plan-reestructura/censo-contingentes.md` §d
- [ ] **(e) Alertmanager** — `ops/observability/alertmanager.yaml` + `deploy/compose.alertmanager.yaml`: el servicio no aparece en `compose-files.sh` ni en los contenedores productivos. Decisión D2 lo cierra.  → `plan-reestructura/censo-contingentes.md` §e
- [ ] **(f) Resto suelto** — `ops/private/CREDENTIAL-INVENTORY.local` (borrable seguro cuando autorices), `ops/scripts/separar-config-alias.mjs` (mencionado en test vivo), `Makefile` (sin consumidores fuera de sí mismo), 7 tests huérfanos + 1 `deploy/liveness-probe.mjs` (sin invocadores). Revisar y borrar lo inequívoco.  → `plan-reestructura/censo-contingentes.md` §f

---

## (3) Vistas de consola — 8 a retirar, decisión de Gemini pendiente desde ronda 2

- [ ] **8 vistas/alias a `_legado`** (ahorro estimado ~1.027 líneas reales de src (la cifra previa de ~4.700 estaba inflada 4,5×) + reducción de superficie del gateway):
  `jobs` · `chains` · `audit` · `relays` (egress) · `topology` · `fleet/:tenant/:alias` · `adapters` · `role-brief-tab`. Todas con 0 visitas humanas en 3,5 días. ¿Apruebas la poda integral, conservas alguna, o la pospones para después de FASE 3?  → `ordenes/reportes/gemini-vistas-sin-uso — OJO: la fila "topology" incluye hypergraph-layout, que /live SÍ usa; talarla literal rompe /live (excluirla o partir antes).md` (15 entradas evaluadas; 7 conservadas en `/`, `/live`, `/accounts`, `/messages`, `/queues`, `/observability`, `/config`, `/terminal`)

---

## (4) Residuos de host aprobables — ~2,3 GB recuperables

Inventario y comandos exactos por fila en `ordenes/reportes/minimax-residuos-host.md`. Producción viva intacta.

- [ ] **8 contenedores huérfanos** (3 postgres `Up (healthy)` sin identificación + 5 stopped).  → §(a)
- [ ] **13 árboles `/opt/cauce-v3-release-*`** — **~620 MB recuperables**.  → §(b)
- [ ] **18 tags `rc-<sha>` del registry** (9 hashes × 2 repos `cauce-v3-runtime`/`-console`).  → §(c.1)
- [ ] **5 tags `*-legacy`** del registry (`cauce-v3-runtime-legacy`, `-directiva-legacy`, `cauce-v3-console-legacy`, `cauce-v3-postgres-legacy/index`).  → §(c.2)
- [ ] **5 imágenes locales del daemon** (`verificacion-dockerfile-fix` + 4 `cauce-rollback-bridge:repro-*`) — **~1,3 GB**.  → §(c.3)
- [ ] **Clon muerto `/datos/workspaces/cauce-v3`** — **~366 MB** (ya archivado en `cauce-v3-archivo-completo-20260827.bundle` 7,3 MB y `cauce-rescate-worktrees-20260827.tar.gz` 14,1 MB).  → §(d)

Total recuperable: **~2,3 GB** antes de GC de blobs.

---

## (5) Ventana de FASE 3 — qué pasará y cuánto tarda

**Antes de la ventana (sin tocar producción):**

- `plan-reestructura/fase3/pre-ventana-codigo.md` completo en `main` con gate verde (regex base64 + pie de fan-in apagado + Dockerfile limpio + compose canónico único + launcher PTY siega huerfanos).
- Matar los 12 pty-agents huérfanos de `fase3/pty-huerfanos.md` y verificar churn ≈ 0 local — puede hacerse HOY.
- Las 5 decisiones de arriba marcadas.

**La ventana (con el dueño presente, asumiendo ~2–3 horas si todo va bien):**

1. Backup de BD verificado (restore drill sobre contenedor efímero).
2. Cerrar/revocar las 3 `terminal_sessions` abiertas de julio (bloqueante B1); editar la lista de flota de 029 según D1.
3. `prod.env`: añadir `CAUCE_TERMINAL_RELAY_INSTANCE_ID=…` (B2), las rutas `gateway_relay_client_*` (B3), borrar 3 líneas rancias de `relay-cert`.
4. Construir imágenes desde `main` (Dockerfile arreglado + los 2 parches de `/etc/cauce-v3/patches/` portados: regex base64, pie de fan-in).
5. Migrar 026–037 en una sola transacción (si algo revienta, rollback automático).
6. `docker compose up -d --wait` con el compose canónico único (adiós overrides, adiós `/opt`).
7. Smoke del efecto real: mensaje A→B `done`; `GET .../documents` ≠ 404; editar un fichero desde la API y leerlo cambiado dentro del contenedor (`docker exec cat`); sesión TUI viva >60 s.
8. Append de una línea (fecha, commit, digests, smoke) a `deploy/HISTORIAL.md`.

**Riesgos previstos:** los 4 runtimes distintos que conviven hoy se unifican con el primer `up -d` canónico — un cambio grande de código + esquema a la vez. Si algo falla dos veces, PARAR y documentar — no encadenar fixes de fontanería como el 26-ago (14 commits `fix:` en 3 horas, 17 intentos, 0 éxitos).

Detalle completo: `plan-reestructura/fase3/00-DOSSIER.md` (43 líneas, conclusión en 5 + orden de la ventana + tabla de decisiones) + `migraciones.md` (las 12, veredicto a veredicto) + `compose-canonico.md` + `pty-huerfanos.md`.

---

## Cómo se cierra cada item

1. Marca el checkbox `[x]` en este fichero.
2. Si es una orden para un agente: añádelo a `ordenes/{codex,gemini,opencode-minimax}.md` y referencia este doc.
3. Si es una acción destructiva en disco: el dueño la corre a mano (los agentes no tocan `/opt`, `/etc/cauce-v3`, ni producción).
4. Para los items D1–D5 y la poda de vistas: una vez marcados, la ventana de FASE 3 ya no tiene bloqueo de decisión.