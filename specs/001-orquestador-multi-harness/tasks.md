# Tasks: Cauce como orquestador de agentes multi-harness

**Input**: Design documents from `/specs/001-orquestador-multi-harness/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: OBLIGATORIOS (constitución I): cada historia cierra con gate pegado
o efecto en la pila de pruebas. Sin evidencia no hay done.

**Organization**: por historia (US1–US5); cada task lleva su **sector**
(`ordenes/00-PROTOCOLO.md`) porque el árbol es compartido y sin ramas.

## Format: `[ID] [P?] [Story] [Sector] Description`

- **[P]**: paralelo (ficheros distintos, sin dependencias)
- **[Story]**: US1..US5
- **[Sector]**: dueño de escritura del área tocada

## Phase 1: Setup SDD (completa en 2026-09-27)

- [x] T001 [US2] [sdd] `specify init` offline + constitución v1.0.0 en
  `.specify/memory/constitution.md`
- [x] T002 [P] [US2] [sdd] integraciones claude (default) + codex + muse
- [x] T003 [P] [US1] [sdd] spec/plan/research/data-model/contracts/quickstart
  de `specs/001-orquestador-multi-harness/`
- [x] T004 [US1] [ops] pila `ops/compose.test.yaml`: imágenes construyen,
  4 servicios saludables, arnés e2e corre

**Checkpoint**: SDD constituido; el resto del plan es ejecutable por la flota.

---

## Phase 2: Fundacional — tabla única de parámetros (US2, P1)

**Goal**: cero parámetros fantasma (SC-003).

- [x] T010 [US2] [protocol] inventariar parámetros vigentes con unidad+fuente:
  `packages/protocol/src/ficheros-del-arnes.ts` (`PRESUPUESTOS_DE_CONTEXTO`,
  `TOPES_OPENCLAW`), deadlines (`CAUCE_ACK_DEADLINE_MS`),
  polls (`DISPATCHER_POLL_MS`), framing 64 KiB, `AGENT_PROFILE_LIMITS`
- [x] T011 [P] [US2] [store] inventariar parámetros de BD: estados, backoff de
  reintentos, poda/GC, retención de outbox/auditoría (`packages/store/src/`)
- [x] T012 [P] [US2] [gateway] inventariar parámetros de admisión: topes WS,
  TTL de tickets, reintentos hello (`services/gateway/src/`)
- [x] T013 [US2] [docs] publicar la tabla en `docs/parametros.md` (una fila =
  nombre, unidad, fuente medido/dueño, valor, test o sonda que lo cubre)
- [x] T014 [US2] [dueño] cerrar FR-011..FR-015: techo nativo (011), poda TUI
  30d (012→T014a), sin poda secrets (013), recarga por alias sí (014→T021),
  medir antes de SLO (015→T014b)
- [x] T014a [US2] [terminal] sweeper de grabaciones TUI >30 días (FR-012)
  (`recording-retention.ts`, TDD 5/5 verde, fail-closed; cableado pendiente)
- [x] T014b [US2] [qa] medir latencias por escenario en la pila y proponer SLO (FR-015)
  (11×<1s, DLQ ~3s, redelivery ~30s; propuesta en research R9; suites en serie)
- [x] T015 [US2] [calidad] sonda `quickstart §3` automatizada: falla si aparece
  un parámetro sin fila en la tabla (`tests/unit/parametros.test.ts`, 186 símbolos triados)

**Checkpoint**: `docs/parametros.md` existe; toda fila con unidad+fuente+valor
o pregunta abierta (SC-003).

---

## Phase 3: US1 Hablar entre harness (P1) 🎯 MVP

**Goal**: e2e verde publicación→reclamo→ACK→`done` entre harness distintos.

**Independent Test**: `quickstart §2` (SC-001, SC-006).

- [x] T020 [P] [US1] [harness] mapear los 5 escenarios esenciales a casos del
  arnés (`ops/harness/`): precondición, pasos, efecto esperado en BD
- [x] T021 [P] [US1] [gateway] cubrir huecos WF2: validación publish/console/
  chain-gates, cuotas, sealing/redaction/receipts con tests de contrato
  (5 ficheros nuevos, 61/61 verde; fix fail-closed `limit` en chain-gates.ts;
  FR-014 verificado con test)
- [x] T022 [US1] [dispatcher] cubrir hueco WF2: política de re-siega y backoff
  documentada + test (`services/dispatcher/`, config.test.ts 45/45; test
  colocalizado fusionado al existente para que corra en gates)
- [x] T023 [US1] [sdk] re-verificar bajo carga el rojo de `adapter-sdk`
  (914/915 en reposo y carga 4/4; rojo-bajo-carga reconfirmado arreglado;
  único fail preexistente: falta `@modelcontextprotocol/sdk` en checkout)
- [x] T024 [US1] [qa] corrida e2e completa contra la pila + evidencia pegada
  — VERDE 14/14, exit 0 (2026-09-27)
- [x] T025 [US1] [despliegue, con dueño] copiar `ops/harness/` completo en la
  etapa `qa-runtime` de `deploy/Dockerfile`; sumar servicio `seed` con la
  topología (12 agentes) y subir `CAUCE_RETRY_TIMEOUT_MS` a 45000 para cubrir
  el backoff deliberado de 30s del intento 1; reconstruir y re-correr T024

**Checkpoint**: US1 funciona y se demuestra (SC-001).

---

## Phase 4: US3 Alta/baja trivial (P2)

**Goal**: alta/baja sin tocar código (FR-004, runbook vigente).

- [x] T030 [US3] [ops] test de ida y vuelta en la pila: fila → regenerar →
  `validate.sh` → reclamo OK → `enabled=false` → rechazo en transacción
  (`ops/tests/alta-y-baja-en-pila.test.mjs`, verde en pila fresca)
- [x] T031 [US3] [docs] alinear `ops/runbooks/alta-y-baja-de-agente.md` con lo
  probado (SQL probado por T030; BotFather marcado como única credencial
  humana; plano PTY y primer turno openclaw siguen manuales operativos)

**Checkpoint**: US3 probada en la pila sin intervención manual salvo BotFather.

---

## Phase 5: US4 Rescate por TUI/CLI (P2)

**Goal**: destrabar por CLI/consola con auditoría (FR-006, FR-007).

- [x] T040 [P] [US4] [cli] atascar a propósito en la pila y destrabar por
  `ops/cli/cauce` verificando el cambio en BD (driver `pila-test` +1 línea CLI,
  test verde con clon `done` y auditoría `delivery.replay/allow`)
- [x] T041 [P] [US4] [consola] verificar negación a sesiones sin atribución
  (gobierno-escritura y teclado) + anuncio inmediato de relay caído
  (2 ficheros nuevos; suite consola 173/173, 2002 tests verde)
- [x] T042 [US4] [dueño] decidir: ¿la shell sin atribución se cierra también?
  (decisión 2026-09-27: dejar como está; T041 lo fija con tests)

**Checkpoint**: rescate demostrado por las dos vías.

---

## Phase 6: US5 UI multi-socio (P3)

**Goal**: especificar permisos + auditoría sin implementar de más.

- [x] T050 [US5] [consola] matriz permiso→vista (`config.write` et al.) con
  tests de visibilidad por rol (12 tests; suite 174/174, 2014 verde)
- [x] T051 [US5] [store] auditoría de mutaciones consultable (quién/qué/cuándo);
  consultable hoy vía `GET /v3/console/audit`; propuesta en
  `specs/001-.../auditoria-propuesta.md`, sin migración nueva

**Checkpoint**: US5 especificada y contenida; implementación futura.

---

## Phase 7: Poda guiada del monstruo (transversal)

**Goal**: la deriva `main..dev` ordenada y el árbol encogiendo (SC-004).

- [x] T060 [P] [calidad] los 19 ficheros >800: uno por task-hijo, sólo encoger
  (19/19: A 7 tests puros 159=159, B terminal 2035→710+771+298+297 +
  health 603+419, C scripts+medico 2911→1887+536+519, D CLI 1444→724+725 +
  resto, E runtime 1648→481+679+364+229; suites verdes)
- [x] T061 [P] [sectores] `git rm` del código muerto citado en doctrina
  (veredicto confirmado por el dueño: ultimate-terminal VIVO, zeus solo
  generado, sin legado openclaw, build-adapter-release.sh herramienta viva;
  nada califica para rm)
- [x] T062 [dueño] decidir destino de ramas vivas: `hospitales`,
  `zeus/turno-vivo-panel-kratos`, `zeus/tope-openclaw-90k`, `feat/blobs-1gb`
  (decisión dueño: cerrar 2 obsoletas verificadas ancestro+diff vacío,
  mantener hospitales, mergear blobs-1gb; merge 61ee3534, 3 conflictos
  resueltos con cadena Blobs→Emission→Quotas; nota: apareció
  origin/zeus/harness-muse, fuera de este veredicto)
- [x] T063 [docs] re-verificar `roadmap.md` ítem por ítem contra el árbol
  (como el 30-08: cerrado/sigue/no-verificado, sin suponer)

**Checkpoint**: SC-004 verde y roadmap veraz.

---

## Phase 8: Cierre y deuda de despliegue

- [ ] T070 [dueño] decidir ventana: qué entra de `dev` a `main`, desplegar,
  escribir filas en `deploy/HISTORIAL.md` (SC-005)
- [ ] T071 [ops] verificar raspado `cauce-relay` en Prometheus tras desplegar
  `6cecfb33` (dns_sd en silencio = falta invisible)
- [x] T072 [qa] `pnpm test` completo + `validate.sh` + e2e en pila, evidencia
  pegada en HISTORIAL (e2e 14/14 PASS exit 0 sobre merge 61ee3534 en serie;
  alta/baja + rescate en pila exit 0; unit 1774/1778, 4 rojos preexistentes
  ambientales: SDK MCP + jsonschema; typecheck/lint solo error preexistente
  SDK; calidad solo 3 rojos ajenos; pendiente dueño: pegar en HISTORIAL
  al desplegar T070)

**Checkpoint**: deuda a cero; SDD 001 completo.

---

## Dependencies & Execution Order

- Phase 1 completa → Phase 2 (fundación) BLOQUEA US1/US3/US4/US5.
- Tras Phase 2: US1 (P1) primero; US3/US4 en paralelo por sector distinto;
  US5 contenida; Phase 7 en paralelo continuo (ficheros disjuntos).
- Phase 8 la ejecuta el dueño con operador; nadie más publica `main`.
- Regla flota: ficheros DISJUNTOS por subagente, tope 4, profundidad 1; sólo
  el proceso principal commitea; commit siempre con pathspec del sector.

## Parallel Example

```bash
# Tras Phase 2, por sectores disjuntos:
Task: "T020 arnés: 5 escenarios → ops/harness/"
Task: "T021 gateway: tests publish/console/chain-gates"
Task: "T030 ops: test alta/baja en pila"
Task: "T060 calidad: partir terminal.plugin.test.ts"
```
