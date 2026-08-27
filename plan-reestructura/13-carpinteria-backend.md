# 13 — Carpintería de backend (partir los monolitos)

**Fase:** 1 · **Tamaño:** grande, cirugía · **Ejecutor:** GPT 5.6 Ultra o Claude (Opus) · **Revisor:** Codex
**Rama:** ninguna — directo a `main` · **Depende de:** 12 mergeado (para no carpintear lo que va a cuarentena)

## Objetivo
Los tres archivos monstruo del backend crecieron por acreción pura (repository.ts: 40 commits, ratio 18:1 añadido:borrado, jamás podado). Partirlos en módulos por responsabilidad, **sin cambiar comportamiento**.

## Alcance y plan de corte

### A. `packages/store/src/repository.ts` (~11.000 líneas, 74 métodos, 1 clase)
Partir `CauceRepository` en módulos por dominio, la clase queda como fachada fina que delega:
- `repository/messages.ts` — publish, receipts, verifyPublishReceipt
- `repository/deliveries.ts` — claim/ack/lease/fencing/heartbeat
- `repository/outbox.ts` — outbox, dead letters, replay
- `repository/jobs.ts` — jobs + fairness (candidato a legado si `jobs` sigue con 0 filas)
- `repository/config.ts` — tenants, rooms, memberships, ACL, revisiones/rollback
- `repository/agents.ts` — agents, role_brief, perfiles
- `repository/observability.ts` — métricas, poda, auditoría
- `repository/quotas.ts` — TODO lo de cuotas (así queda listo para cuarentena si el dueño decide)
Regla dura: **cero cambios de lógica ni de SQL** en esta fase. Solo mover funciones y cablear imports. Los tests existentes (19.752 líneas en packages/store/test) deben pasar sin editar salvo imports.

### B. `services/gateway/src/app.ts` (~3.500+ líneas)
- Extraer registro de rutas por área: `routes/core.ts` (publish/ack/ws/query/heartbeat), `routes/console.ts`, `routes/health.ts`. `app.ts` queda como composición.
- Las rutas marcadas `LEGADO-CANDIDATO` en 12 (publish-intents, chain-gates) se extraen a su propio módulo `routes/legado-candidato.ts` con un flag de activación, para que la tala futura sea un `git rm`.

### C. `services/gateway/src/terminal/plugin.ts` (~2.000+ líneas)
- Separar: plano de control de sesiones (targets/sessions/tickets) vs proxy del relay (relay/*) vs sondas de gobierno (directive/documents probe). Tres ficheros.

### D. `packages/adapter-sdk`
- No partir en esta fase (es grande pero cohesivo y con 674 tests verdes). Solo: mover los ejecutables sin usuarios reales (`hermes`, `opencode`, y `fake` si solo lo usan tests) a un subdirectorio `bin/experimental/` y anotarlo en el README del paquete. La flota real usa `openclaw.js`, `claude`, `codex`.

## Reglas de ejecución
- Un commit por módulo extraído. `git mv`/creación de fichero + edición de imports en el MISMO commit está bien aquí (es una extracción), pero nada más en ese commit.
- Prohibido "aprovechar para mejorar" lógica, renombrar conceptos o tocar SQL. Eso es FASE 2/3.
- Sin comentarios narrativos nuevos.

## Gate de aceptación
- `pnpm typecheck && pnpm lint` verdes tras CADA commit.
- `pnpm test:unit` (adapter-sdk + mcp) verdes; suites de store (`packages/store/test`) verdes con Docker si están disponibles, o como mínimo typecheck de los tests.
- `wc -l` final: ningún fichero de src > 1.500 líneas en las áreas tocadas.
- Diff revisable: el revisor debe poder confirmar con `git log --follow` que cada función movida es idéntica.
