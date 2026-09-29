# Implementation Plan: Cauce como orquestador de agentes multi-harness

**Branch**: `dev` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-orquestador-multi-harness/spec.md`

## Summary

Convertir el bus actual en el orquestador especificado sin reescribir: (1)
fijar la tabla única de parámetros con unidad + fuente + valor; (2) podar lo
monstruoso guiado por métricas (topes de `calidad.mjs`, cobertura de gates);
(3) validar cada incremento contra `ops/compose.test.yaml` + gates del repo.
Enfoque: corrección por sustracción y fijación de parámetros, no features nuevas.

## Technical Context

**Language/Version**: TypeScript 5 (ESM estricto), Python 3 (harness/ops), bash

**Primary Dependencies**: pnpm workspaces, `pg`, `zod`, vitest, Docker Compose

**Storage**: PostgreSQL 16, única fuente durable; migraciones en
`packages/store/migrations/` (se borran enteras, no se editan)

**Testing**: vitest (`test:unit` por commit, `test` completo nocturno),
arnés e2e `ops/harness/runner.mjs --live`, `shellcheck`, `ruff`, ESLint,
`ops/scripts/validate.sh`, `scripts/calidad.mjs`

**Target Platform**: VPS Linux (root real) + contenedores; consolas por web

**Project Type**: bus durable multi-harness (gateway + dispatcher + puentes +
consola + SDK) con flota derivada de BD

**Performance Goals**: [NEEDS CLARIFICATION: SLO por escenario — ver FR-015.
Hoy sólo hay números de test: `CAUCE_ACK_DEADLINE_MS=50`,
`DISPATCHER_POLL_MS=20`, framing 64 KiB.]

**Constraints**: fencing `claim_token`+`epoch`+intento en toda reclamación;
fail-closed; trinquete de líneas sólo-baja; sin ramas de tarea; Actions
prohibido; `main` publica el dueño

**Scale/Scope**: 14 agentes / 4 tenants; árbol ~277k líneas de código;
922 ficheros de deriva `main..dev` por ordenar antes de la próxima ventana

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- I Efecto demostrado: cada fase termina en gate pegado o efecto en la pila
  de pruebas; sin excepciones. PASA.
- II Una sola fuente: la tabla de parámetros deriva de hechos medidos o
  decisión del dueño; la flota sigue en BD. PASA.
- III Poda: el plan ordena podar antes de añadir; ningún fichero nuevo sobre
  el tope. PASA.
- IV Convivencia: todo en `dev`, sectores disjuntos, pathspec, sin ramas.
  PASA (ver Complexity Tracking por la adaptación del flujo speckit).
- V Fencing: no se relaja ningún cerco; FR-007/edge-cases lo refuerzan. PASA.
- VI Credenciales: ningún task toca `ops/private/credentials/`. PASA.
- VII Spec-first: este spec + plan + tasks es la primera aplicación. PASA.

Re-chequeo tras Phase 1: sin cambios de diseño que lo invaliden.

## Project Structure

### Documentation (this feature)

```text
specs/001-orquestador-multi-harness/
├── spec.md              # qué y por qué (user stories, FR, SC)
├── plan.md              # este fichero
├── research.md          # decisiones de descubrimiento (Phase 0)
├── data-model.md        # entidades conceptuales (Phase 1)
├── quickstart.md        # validación paso a paso (Phase 1)
├── contracts/           # contratos HTTP/WS del núcleo (Phase 1)
└── tasks.md             # pasos ejecutables (Phase 2)
```

### Source Code (repository root)

```text
services/
├── gateway/src/         # HTTP/WS, leases, ACK, fencing
├── dispatcher/          # segador de reintentos
├── terminal-relay/      # plano de datos terminal (sin BD)
└── telegram-bridge/     # pollers + egress con lease
packages/
├── store/               # repository, migraciones, fleet-activity
├── protocol/            # zod schemas, sealing, redaction, topes
├── adapter-sdk/         # consumidor durable + contextos nativos
└── mcp-fleet-monitor/   # monitor de flota
console/                 # consola web del operador (9 vistas)
ops/
├── compose.test.yaml    # pila de pruebas (validación de sistema)
├── flota.json           # flota derivada (generado desde BD)
├── pty-agent/           # launcher PTY + siega
├── runbooks/            # alta/baja, operación
└── harness/             # arnés e2e
tests/                   # suites unit/integration/hardening
scripts/                 # test-all.mjs, calidad.mjs (trinquete)
deploy/                  # compose, Dockerfile, HISTORIAL.md
```

**Structure Decision**: sin reestructura física en este spec. La poda (punto 1
de doctrina: "legibilidad primero") se ejecuta task a task con métrica, no con
un big-bang de carpetas que rompería los 8 sectores en vuelo.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Flujo speckit sin ramas (`create-new-feature.sh` crea rama) | Constitución IV prohíbe ramas de tarea; la convivencia es por sector en `dev` | Crear ramas rompería el protocolo multi-instancia y el gate nocturno sobre `origin/dev` |
| 5 historias en un spec en vez de 5 specs | US1+US2 son el reto pedido (P1) y US3–US5 fijan el marco para no cerrar puertas al podar | Partirlo en 5 specs multiplicaría ceremonia sin ejecutor distinto por spec |

## Phases

### Phase 0 - Research (completa)

Ver `research.md`: decisiones R1–R6 con evidencia (init speckit offline,
integraciones claude/codex/muse, pila de pruebas coherente y verificada,
métricas del monstruo, adaptación sin ramas).

### Phase 1 - Design (completa)

`data-model.md`, `contracts/`, `quickstart.md`. Sin migraciones nuevas: el
modelo conceptual describe lo que ya existe para fijar parámetros sobre hechos.

### Phase 2 - Tasks (completa)

Ver `tasks.md`: setup → fundación (tabla de parámetros) → US1..US5 →
validación de sistema → poda guiada → cierre (HISTORIAL al día).
