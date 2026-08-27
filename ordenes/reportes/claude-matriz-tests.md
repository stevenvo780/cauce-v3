# Matriz pesada de tests — triage del integrador (27-08, post-carpintería)

Suites que NUNCA entran en el gate diario, corridas como `stev` sobre HEAD tras toda la carpintería.

## Resultados

| Suite | Resultado |
|---|---|
| `test:terminal-pty` | **VERDE** 86/86 |
| `test:services` (gateway+dispatcher+telegram) | **VERDE** (gateway 471/471 y resto) |
| `test:gateway-hardening` | **2 ROJOS** de 117 (15/17 ficheros verdes; el de fencing real contra PostgreSQL, VERDE) |
| `test:store-hardening` (testcontainers) | corriendo — se anexa al llegar |

## Los 2 rojos — ambos sector CODEX

### 1. `tests/gateway-hardening/wake-outbox-routing.test.ts` › "treats ackOutbox applied=false as an observable fenced result, never success" — **PRIORIDAD: posible regresión REAL**
`expected false to be true`. Sospechoso directo: `28c6c00` ("store: incorpora guardas del parche opaco") toca semántica de ACK (`acusarAhora`, `ackVentanaSilencioMs`) y este test protege el contrato "un ACK con applied=false es un resultado VALLADO observable, nunca éxito". Investigar si la guarda portada cambió el contrato: si el producto está mal → arreglar producto; si el contrato evolucionó legítimamente → actualizar test CON justificación escrita. No es un rojo de entorno.

### 2. `tests/gateway-hardening/perfil-en-el-saludo.test.ts` › "la capability tiene un nombre versionado"
El conocido (revisión ola 2): lee `app.ts` como TEXTO y la cadena `hello.capabilities.includes('agent_p…')` vive ahora en `routes/core.ts`. Ya está en tu orden (Cierre) — actualizar la ruta que lee el test.

## Nota
`wake-outbox-postgres.test.ts` (fencing contra PostgreSQL real, 20s) está VERDE: las extracciones de deliveries/fencing pasan la prueba de fuego con base real.
