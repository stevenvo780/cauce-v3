# Matriz pesada de tests — triage del integrador (27-08, post-carpintería)

Suites que NUNCA entran en el gate diario, corridas como `stev` sobre HEAD tras toda la carpintería.

## Resultados

| Suite | Resultado |
|---|---|
| `test:terminal-pty` | **VERDE** 86/86 |
| `test:services` (gateway+dispatcher+telegram) | **VERDE** (gateway 471/471 y resto) |
| `test:gateway-hardening` | **2 ROJOS** de 117 (15/17 ficheros verdes; el de fencing real contra PostgreSQL, VERDE) |
| `test:store-hardening` (testcontainers) | **581/601 verdes; 20 rojos en 5 ficheros** (ver §3) |

## Los 2 rojos — ambos sector CODEX

### 1. `tests/gateway-hardening/wake-outbox-routing.test.ts` › "treats ackOutbox applied=false as an observable fenced result, never success" — **PRIORIDAD: posible regresión REAL**
`expected false to be true`. Sospechoso directo: `28c6c00` ("store: incorpora guardas del parche opaco") toca semántica de ACK (`acusarAhora`, `ackVentanaSilencioMs`) y este test protege el contrato "un ACK con applied=false es un resultado VALLADO observable, nunca éxito". Investigar si la guarda portada cambió el contrato: si el producto está mal → arreglar producto; si el contrato evolucionó legítimamente → actualizar test CON justificación escrita. No es un rojo de entorno.

### 2. `tests/gateway-hardening/perfil-en-el-saludo.test.ts` › "la capability tiene un nombre versionado"
El conocido (revisión ola 2): lee `app.ts` como TEXTO y la cadena `hello.capabilities.includes('agent_p…')` vive ahora en `routes/core.ts`. Ya está en tu orden (Cierre) — actualizar la ruta que lee el test.

## Nota
`wake-outbox-postgres.test.ts` (fencing contra PostgreSQL real, 20s) está VERDE: las extracciones de deliveries/fencing pasan la prueba de fuego con base real.

## §3 — store-hardening: los 20 rojos (anexo)

**Diagnóstico del primero (5 tests, causa única):** `terminal-relay-instance-fencing-migration-postgres.test.ts` — su SETUP baja la migración 036 para simular el mundo pre-034, y desde que existe la 037 (c7345da, 26-ago) la guarda anti-downgrade lo rechaza («cannot downgrade schema 036 while a later migration is present»). **Rojo PREEXISTENTE a toda la reestructura**, de arnés, no de producto: el setup debe bajar 037 antes que 036 (o construir el estado pre-034 por otra vía). Afecta solo al camino *down*, que FASE 3 no usa (rollback de BD = backup).
**Sector: Codex** (tests de store). CUADRO COMPLETO (segunda corrida): DOS causas raíz, ninguna de producto:
- **Causa A (determinista, la mayoría)**: arneses que BAJAN migraciones para simular estados viejos, rotos desde que existe la 037 — errores «cannot downgrade schema 036/031 while a later migration is present» (14+3 casos) en `terminal-relay-instance-fencing-migration-postgres` (5), `agent-profile-migration-postgres` (1) y afines. Arreglo único: helper de downgrade en orden inverso desde 037.
- **Causa B (flaky bajo carga)**: `adversarial-postgres.test.ts` — ECONNREFUSED al contenedor de test ×5 + un timeout de condición; la distribución CAMBIA entre corridas (20 rojos primera, otra mezcla la segunda, host cargado con instancias trabajando). Arreglo: espera-de-ready robusta en el arranque del contenedor del arnés; re-verificar en host tranquilo antes de tocar nada.
**Higiene confirmada:** cero contenedores testcontainers huérfanos tras la corrida (el fix del Ryuk funciona).
