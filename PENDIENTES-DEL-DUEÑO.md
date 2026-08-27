# PENDIENTES DEL DUEÑO — la única página que necesitas leer

Formato: cada punto lleva su **Respuesta:** debajo — escribe ahí tu decisión CON matices (texto libre; "sí pero…", "no porque…", condiciones, lo que sea). Marca `[x]` cuando lo des por decidido. Claude lee tus respuestas y ejecuta la cascada.

---

## SECUENCIA DE CIERRE ACORDADA (27-08 noche)

1. Instancias cierran órdenes activas + censo de funciones muertas → revisión final + foto v2.
2. Ajuste de rutas PRE-despliegue corto y seguro (`deploy/runtime/`, ~11 refs) — Claude, re-validando render + builds. Nada más se mueve antes de desplegar.
3. El dueño responde este doc (en paralelo, desde ya).
4. **PRIMEROS DESPLIEGUES REALES** (guion ensayado: backup → build → migrar 2,4s → up → smoke).
5. Post-primer-despliegue: cirugía de dominios (`flota/`, consola a raíz, ops repartida).

**Respuesta (¿de acuerdo con la secuencia? ¿cuándo tienes ventana de ~2-3h?):**

---

## (1) Decisiones D1–D5 — el despliegue no arranca sin estas

### [ ] D1 — Flota de la migración 029 (ENSAYADA contra un clon: es decisión DOBLE)
(a) Deshabilita 3: `Jhon/heraclito`, `Jhon/tales`, `Miguel/gaia` (fila y FKs se preservan). (b) **Da de alta los 4 agentes de Pablo**: `dedalo` (codex), `midas`+`seneca` (openclaw), `vulcano` (claude) — flota 14→18, 15 enabled; nacen sin perfil (no rompe; no publican perfil hasta dárselo). ¿Aplicar tal cual, o editar la lista del SQL antes? → `plan-reestructura/fase3/00-DOSSIER.md` §Ensayo

**Respuesta:**

### [ ] D2 — Alertmanager
El `prometheus.yaml` nuevo trae reglas de alertmanager pero el servicio no está en el compose. ¿Desplegarlo con receptor Telegram (7 variables a aprovisionar) o recortar esas reglas? Sin decidir, `CauceAlertmanagerDown` queda critical encendida para siempre. → `compose-canonico.md` §6

**Respuesta:**

### [ ] D3 — Origen del compose
¿Correr desde el repo (recomendado: una sola fuente) o seguir copiando a `/opt`? Cambia el source de 4 binds. → `compose-canonico.md` §5

**Respuesta:**

### [ ] D4 — Bloque B de pty-huérfanos
`heraclito`/`tales`: churn cero, alias ya fuera del mapa. ¿Se matan también? (2 de los 12 del kill-list) → `pty-huerfanos.md`

**Respuesta:**

### [ ] D5 — Censo de huérfanos en el OTRO host
El bucle de `dedalo`/`salva` viene de otra máquina. ¿Cuándo hacemos allí el mismo censo? → `pty-huerfanos.md`

**Respuesta:**

---

## (2) Dudosos restantes del censo (agrupados)

### [ ] (a) Herramientas de otras máquinas — `cauce-portatil`, `compilar-en-torre`
Cero uso en zeus; pensadas para tu portátil y la torre. ¿Borrar (git recuerda), o conservar?

**Respuesta:**

### [ ] (b) Familia DLQ manual — `dlq_cli.py` + 5 wrappers + 3 schemas
Herramientas de emergencia del operador, sin runner automático. ¿Vivas o fuera?

**Respuesta:**

### [ ] (c) Console-legibilidad — 6 ficheros de medición CDP
Tooling manual sin integración ni CI. ¿Fuera o se queda?

**Respuesta:**

### [ ] (d) Quota-collector + backups ut-nexus
La base escribe muestras pero no está claro quién colecta aquí (¿kratos?). ¿Conectar, esperar, o fuera?

**Respuesta:**

### [ ] (e) Alertmanager (ficheros) — lo cierra tu D2

**Respuesta:** (la misma que D2)

### [ ] (f) Resto suelto — CREDENTIAL-INVENTORY.local, liveness-probe.mjs, 7 tests huérfanos, Makefile raíz
Revisar y borrar lo inequívoco cuando autorices.

**Respuesta:**

---

## (3) Vistas de consola — 8 candidatas a retirar (~1.027 líneas reales de src)
`jobs` · `chains` · `audit` · `relays` · `topology` · `fleet/:tenant/:alias` · `adapters` · `role-brief-tab` — todas con 0 visitas humanas en 3,5 días. **OJO**: la fila `topology` incluye `hypergraph-layout`, que `/live` SÍ usa — se excluye o se parte antes (ya avisado a los ejecutores). ¿Poda integral, conservar algunas (di cuáles), o posponer a después de FASE 3? → `ordenes/reportes/gemini-vistas-sin-uso.md`

**Respuesta:**

---

## (4) Residuos de host — ~2,3 GB recuperables (tú los corres a mano, comandos listos)
Detalle y comando por fila en `ordenes/reportes/minimax-residuos-host.md`: 8 contenedores huérfanos · 13 árboles `/opt/cauce-v3-release-*` (620MB) · 18 tags `rc-*` + 5 `*-legacy` del registry · 5 imágenes locales (1,3GB) · clon muerto `/datos/workspaces/cauce-v3` (366MB, ya en el bundle).

**Respuesta (¿apruebas todo el bloque, o excluyes algo?):**

---

## (5) La ventana de FASE 3 — informativa (ya ensayada, ~2-3h con margen)
Backup verificado → B1 (revocar 3 sesiones) + flota 029 según D1 → prod.env (instance-id B2, rutas B3, borrar 3 líneas rancias) → build imágenes desde main → migrar 026–037 (2,4s medidos, una transacción, rollback automático probado) → `up -d --wait` canónico → smoke de efectos reales → HISTORIAL. Regla: si algo falla dos veces, PARAR (nunca más 17 intentos invisibles). Detalle: `plan-reestructura/fase3/00-DOSSIER.md`.

**Respuesta (dudas/condiciones para la ventana, si tienes):**
