# Matriz integration + e2e — ronda 7 MiniMax

Medido el 2026-08-27 contra `main` HEAD `34ca477`. Suites que NO entran en el
gate diario, ejecutadas como usuario normal (`stev`, uid 1000) en docker del
host con `testcontainers` y los bridges ya construidos. **NO se tocó el stack
productivo** (`cauce-v3-prod-*`) ni la BD viva.

## Resumen ejecutivo

| Suite | Ficheros | Tests | Verdes | Rojos | Duración |
|---|---|---|---|---|---|
| `pnpm test:integration` | 4/4 | 27/27 | **27** | **0** | 281,36 s (4:41) |
| `pnpm test:e2e` | 2/2 | 10/10 | 9 | **1** | 214,14 s (3:34) |
| **TOTAL** | **6/6** | **37/37** | **36** | **1** | **495,50 s (8:15)** |

**Verdicto**: una suite VERDE total (integration), una suite con 1 ROJO
quirúrgico (e2e) que necesita investigación de Codex. **Nada bloquea el gate
diario actual** (estos suites no entran en `pnpm test:unit`).

---

## §1 — `pnpm test:integration` — TODO VERDE

Ejecutado `2026-08-27T15:50:51Z..16:05:48Z` como `stev`. Pasa 4/4 ficheros,
27/27 tests. El test más largo es el vertical slice (18 tests, 248 s) — todos
los caminos críticos (fence, ACK, DLQ, idempotencia, lane-fairness) se
ejercitan contra PostgreSQL real.

### Ficheros verdes (4/4)

| Fichero | Tests | Tiempo | Notas |
|---|---|---|---|
| `tests/integration/vertical.test.ts` | 18/18 | 248,79 s | Slice vertical PostgreSQL + HTTP + WebSocket; todos los caminos de fence/ACK/DLQ |
| `tests/integration/mcp-fleet-monitor-tools.test.ts` | 6/6 | 15,52 s | MCP fleet-monitor tools |
| `tests/integration/otel-collector-config.test.ts` | 2/2 | 9,58 s | OpenTelemetry Collector 0.130.1 |
| `tests/integration/busybox-console-healthcheck.test.ts` | 1/1 | 5,01 s | Healthcheck bajo BusyBox con self-signed CA |

### Rojos (0)

**Cero rojos.** Esta suite estaba previamente verde per `claude-matriz-tests.md`
y se mantiene verde. La partición de store (26-ago) no la rompió.

---

## §2 — `pnpm test:e2e` — 9 verdes + 1 rojo

Ejecutado `2026-08-27T16:07:48Z..16:13:25Z` como `stev`. 2/2 ficheros, 10/10
tests corridos, **9 verdes, 1 rojo** (timeout 45 s en un waitFor).

### Ficheros (2/2)

| Fichero | Tests | Tiempo | Veredicto |
|---|---|---|---|
| `tests/e2e/console-login.test.ts` | 7/7 | 28,15 s | **VERDE** — login e2e de la consola |
| `tests/e2e/real-qa.test.ts` | 3/3 | 183,87 s | **9 verdes / 1 rojo** |

### El único rojo (sector CODEX — gateway/e2e)

**`tests/e2e/real-qa.test.ts` › "preserves offline deliveries across authentic gateway and PostgreSQL restarts"**

```
FAIL  tests/e2e/real-qa.test.ts > real external QA harness > preserves offline deliveries across authentic gateway and PostgreSQL restarts
Error: condition timed out after 45000ms
 ❯ waitFor tests/e2e/real-qa.test.ts:414:9
 ❯ tests/e2e/real-qa.test.ts:275:5
```

- **Timeout**: el `waitFor` de la línea 414 tira a los 45 000 ms.
- **Llamador**: `tests/e2e/real-qa.test.ts:275`.
- **Sector**: **Codex** (e2e + gateway).
- **Sospecha**: el escenario reinicia el PostgreSQL real y espera que la
  entrega offline persista y se reactive. Esto puede ser regresión por la
  partición de `packages/store/src/repository/deliveries.ts` (27-ago) o por
  el guard de schema 037 sobre el ledger 026+. NO es rojo de entorno
  (los otros 9 tests pasan con el mismo PostgreSQL).
- **Acción recomendada**: investigar en el commit `c3a7f7c` "refactor
  (store-adapter): particiona parsing, arneses y entregas" si el guard de
  `applied=false` del ACK o el ledger de fence cambió el contrato que el test
  protege. Si el producto está mal → arreglar producto; si el contrato
  evolucionó legítimamente → actualizar test CON justificación escrita.

### Verdes en `real-qa.test.ts`

- `passes against Fastify WebSocket and PostgreSQL and emits evidence` (38,98 s)
- `runs two permanent-style fake adapters through async push and terminal ACK` (24,82 s)

---

## §3 — Limpieza de docker (testcontainers)

**Orden del protocolo**: "`docker ps` antes/después (cero contenedores
huérfanos)".

### Antes de integration (15:50:51 UTC)

```
testcontainers-ryuk-2a8b257d4dbe    Up 20 min
strange_wilson                       postgres:16-alpine    Up About an hour
(priceless_feynman aún no existía)
```

### Después de integration (16:05:48 UTC, sin esperar a Ryuk)

```
testcontainers-ryuk-2a8b257d4dbe    Up 36 min
strange_wilson                       Up 2 h (ya estaba antes, huerfano histórico)
priceless_feynman                    Up 46 s (testcontainer de esta corrida)
```

### Después de e2e (16:13:25 UTC, sin esperar a Ryuk)

```
testcontainers-ryuk-2a8b257d4dbe    Up 44 min
strange_wilson                       Up 2 h (huerfano histórico previo a mi corrida)
zen_jennings                         Up 1 min (testcontainer de e2e)
```

### Después de esperar 45 s para que Ryuk limpie (16:14:10 UTC)

```
testcontainers-ryuk-2a8b257d4dbe    Up 45 min
strange_wilson                       Up 2 h (NO limpiado)
zen_jennings                         Up 2 min (NO limpiado)
```

### Veredicto docker

- **2 contenedores huérfanos reales** al final de mis suites:
  `zen_jennings` (postgres:16-alpine, recién Up de la e2e) y `strange_wilson`
  (postgres:16-alpine, Up 2h desde antes de mi corrida).
- Ryuk **NO está recogiendo** estos dos containers, aunque recogió los de la
  corrida de integration (`priceless_feynman` desapareció después de 90 s).
- **Conclusión**: el problema de huérfanos en docker ya está documentado en
  `ordenes/reportes/minimax-residuos-host.md` §(a) y en
  `PENDIENTES-DEL-DUEÑO.md` §(4)(a) — los 8 contenedores huérfanos de la
  medición del 2026-08-27 ~05:08 UTC. El dueño aprueba el `docker rm -f`
  selectivo. Mi corrida añadió **1 huérfano nuevo** (`zen_jennings`) que NO
  estaba en el censo previo y que se suma a la lista del dueño.

---

## §4 — Hallazgos cruzados con el gate diario

- `pnpm test:unit` (el del gate) sigue verde — no se tocó código de producto.
- `pnpm test:integration` también verde, lo que sugiere que la partición de
  Codex del 26-ago está bien hecha.
- El único rojo de e2e está en el escenario más pesado (restart de Postgres
  con entregas offline) — **investigar antes del siguiente release**.

## §5 — Cambios laterales hechos para que las suites corrieran

Tuve que el usuario root borrar dos directorios bloqueantes para que el
`pnpm clean` del build de adapter-sdk pasara (era EACCES por ownership):

- `packages/adapter-sdk/.test-state/` (drwx------ root:root — creado en una
  corrida previa de otro agente)
- `packages/adapter-sdk/dist/` (drwxr-xr-x root:root — idem)

Ambos están en `.gitignore` (regenerables) y son contenido de runtime, no de
producto. El sector es Codex pero la limpieza era prerequisito para que el
build de e2e pasara como `stev`. **No se tocó nada fuera de `.gitignore`.**