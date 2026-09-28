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

- [ ] T010 [US2] [protocol] inventariar parámetros vigentes con unidad+fuente:
  `packages/protocol/src/ficheros-del-arnes.ts` (`PRESUPUESTOS_DE_CONTEXTO`,
  `TOPES_OPENCLAW`), deadlines (`CAUCE_ACK_DEADLINE_MS`),
  polls (`DISPATCHER_POLL_MS`), framing 64 KiB, `AGENT_PROFILE_LIMITS`
- [ ] T011 [P] [US2] [store] inventariar parámetros de BD: estados, backoff de
  reintentos, poda/GC, retención de outbox/auditoría (`packages/store/src/`)
- [ ] T012 [P] [US2] [gateway] inventariar parámetros de admisión: topes WS,
  TTL de tickets, reintentos hello (`services/gateway/src/`)
- [ ] T013 [US2] [docs] publicar la tabla en `docs/parametros.md` (una fila =
  nombre, unidad, fuente medido/dueño, valor, test o sonda que lo cubre)
- [ ] T014 [US2] [dueño] cerrar FR-011..FR-015 o registrar medición: presupuestos
  claude/hermes, retención TUI, poda `secret.granted`, recarga por alias, SLO
- [ ] T015 [US2] [calidad] sonda `quickstart §3` automatizada: falla si aparece
  un parámetro sin fila en la tabla

**Checkpoint**: `docs/parametros.md` existe; toda fila con unidad+fuente+valor
o pregunta abierta (SC-003).

---

## Phase 3: US1 Hablar entre harness (P1) 🎯 MVP

**Goal**: e2e verde publicación→reclamo→ACK→`done` entre harness distintos.

**Independent Test**: `quickstart §2` (SC-001, SC-006).

- [ ] T020 [P] [US1] [harness] mapear los 5 escenarios esenciales a casos del
  arnés (`ops/harness/`): precondición, pasos, efecto esperado en BD
- [ ] T021 [P] [US1] [gateway] cubrir huecos WF2: validación publish/console/
  chain-gates, cuotas, sealing/redaction/receipts con tests de contrato
- [ ] T022 [US1] [dispatcher] cubrir hueco WF2: política de re-siega y backoff
  documentada + test (`services/dispatcher/`)
- [ ] T023 [US1] [sdk] re-verificar bajo carga el rojo de `adapter-sdk`
  (689 tests; arreglo en árbol pendiente de reconfirmación)
- [ ] T024 [US1] [qa] corrida e2e completa contra la pila + evidencia pegada
  — BLOQUEADA por R7 hasta T025
- [ ] T025 [US1] [despliegue, con dueño] copiar `ops/harness/` completo en la
  etapa `qa-runtime` de `deploy/Dockerfile` (hoy sólo `runner.mjs` →
  `ERR_MODULE_NOT_FOUND`); reconstruir `cauce-v3-test-qa:local` y re-correr T024

**Checkpoint**: US1 funciona y se demuestra (SC-001).

---

## Phase 4: US3 Alta/baja trivial (P2)

**Goal**: alta/baja sin tocar código (FR-004, runbook vigente).

- [ ] T030 [US3] [ops] test de ida y vuelta en la pila: fila → regenerar →
  `validate.sh` → reclamo OK → `enabled=false` → rechazo en transacción
- [ ] T031 [US3] [docs] alinear `ops/runbooks/alta-y-baja-de-agente.md` con lo
  probado; lo que pida credencial humana queda marcado (sólo BotFather)

**Checkpoint**: US3 probada en la pila sin intervención manual salvo BotFather.

---

## Phase 5: US4 Rescate por TUI/CLI (P2)

**Goal**: destrabar por CLI/consola con auditoría (FR-006, FR-007).

- [ ] T040 [P] [US4] [cli] atascar a propósito en la pila y destrabar por
  `ops/cli/cauce` verificando el cambio en BD
- [ ] T041 [P] [US4] [consola] verificar negación a sesiones sin atribución
  (gobierno-escritura y teclado) + anuncio inmediato de relay caído
- [ ] T042 [US4] [dueño] decidir: ¿la shell sin atribución se cierra también?
  (pregunta abierta v3.1)

**Checkpoint**: rescate demostrado por las dos vías.

---

## Phase 6: US5 UI multi-socio (P3)

**Goal**: especificar permisos + auditoría sin implementar de más.

- [ ] T050 [US5] [consola] matriz permiso→vista (`config.write` et al.) con
  tests de visibilidad por rol
- [ ] T051 [US5] [store] auditoría de mutaciones consultable (quién/qué/cuándo);
  si falta tabla, proponer migración en spec aparte (no aquí)

**Checkpoint**: US5 especificada y contenida; implementación futura.

---

## Phase 7: Poda guiada del monstruo (transversal)

**Goal**: la deriva `main..dev` ordenada y el árbol encogiendo (SC-004).

- [ ] T060 [P] [calidad] los 19 ficheros >800: uno por task-hijo, sólo encoger
  (empezar por `terminal.plugin.test.ts`, congelado de 2035 líneas)
- [ ] T061 [P] [sectores] `git rm` del código muerto citado en doctrina
  (zeus/OpenClaw legado, `ultimate-terminal` tras decisión del dueño)
- [ ] T062 [dueño] decidir destino de ramas vivas: `hospitales`,
  `zeus/turno-vivo-panel-kratos`, `zeus/tope-openclaw-90k`, `feat/blobs-1gb`
  (merge, `git rm` de lo muerto, o cierre documentado)
- [ ] T063 [docs] re-verificar `roadmap.md` ítem por ítem contra el árbol
  (como el 30-08: cerrado/sigue/no-verificado, sin suponer)

**Checkpoint**: SC-004 verde y roadmap veraz.

---

## Phase 8: Cierre y deuda de despliegue

- [ ] T070 [dueño] decidir ventana: qué entra de `dev` a `main`, desplegar,
  escribir filas en `deploy/HISTORIAL.md` (SC-005)
- [ ] T071 [ops] verificar raspado `cauce-relay` en Prometheus tras desplegar
  `6cecfb33` (dns_sd en silencio = falta invisible)
- [ ] T072 [qa] `pnpm test` completo + `validate.sh` + e2e en pila, evidencia
  pegada en HISTORIAL

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
