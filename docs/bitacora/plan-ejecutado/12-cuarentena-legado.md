# 12 — Cuarentena de subsistemas sin uso

**Fase:** 1 · **Tamaño:** mediano · **Ejecutor:** Claude (Sonnet) · **Revisor:** GPT 5.6 Ultra
**Rama:** ninguna — directo a `main` · **Depende de:** nada (paralelo a 11; coordina con 13 solo en gateway)

## Objetivo
Sacar de la vista de los agentes (y del build) los subsistemas que la auditoría midió como **nunca usados en producción**. Regla: **mover, no borrar** — todo va a `_legado/` con un README de 3 líneas por pieza (qué es, por qué está aquí, evidencia). La tala definitiva se decide después con la cabeza fría.

## Evidencia por pieza (medida en producción, 2026-08-27)

| Pieza | Evidencia de no-uso |
|---|---|
| `services/shadow-router` + shadow-guard | Nunca desplegado; sus 4 tablas shadow_* con 0 filas en 5 semanas; era migración V2→V3 de un solo uso |
| `services/relay-worker` | Nunca desplegado; sustituido por telegram-bridge; target de Prometheus caído 3,5 días con alerta que nadie recibe |
| Maquinaria de release en `ops/scripts/` (deploy-release.sh, pin-production-release.py, release-writer-state.py, produce-rollback-bridge-evidence.py, rollback-baseline.py, release-candidate.py, release-gate.sh, verification-rounds.mjs y validadores asociados) | 17.686 líneas; 0 despliegues logrados en su historia; su gate exige evidencia imposible (gitignored + caduca con cualquier commit); se rodea con docker build a mano |
| `ops/rollback-bridge/` | Reconstruye un commit viejo contra el esquema actual vía patch de 13.691 líneas; el registro de imágenes ya resuelve eso con tags |
| Publish-intents (rutas en gateway `app.ts` /v3/console/publish-intents*) | La migración 037 lo dice: "This state machine has never been deployed"; 0 audit_events console.publish.* |
| Chain-gates (rutas /v3/console/chain-gates* + UI si la hay) | agent_chain_gates: 0 filas; ninguna vista de la consola las llama |
| Cuotas/licencias (packages/store cuota* + vistas quotas/licenses de consola) — **solo marcar, decisión del dueño** | 61.513 muestras escritas, 0 decisiones, 0 eventos de auditoría, índices con 0 scans |
| `ops/harness/` contract/protocol-doubles y `ops/console-legibilidad/`, `ops/ai-live/` | Teatro de evidencia: los 4 harness son "protocol doubles"; medición CDP puntual sin consumidor |

## Tareas
1. Crear `_legado/` en la raíz con `README.md` índice (tabla de arriba).
2. `git mv` de cada pieza a `_legado/<nombre>/` en un commit por pieza. Donde la pieza está entrelazada (publish-intents y chain-gates viven dentro de `services/gateway/src/app.ts` y `packages/store`), NO extraer con cirugía en esta fase: solo marcar con un comentario de una línea `// LEGADO-CANDIDATO: ver docs/bitacora/plan-ejecutado/12` y listarlo en el README de `_legado/`. La extracción real es de 13.
3. Ajustar lo mínimo para que el build siga: quitar de `package.json` los scripts que apuntan a lo movido (test:services de shadow-router/relay-worker, verify:three-rounds, evidence:release-candidate, qa:*), y de `pnpm-workspace.yaml`/`tsconfig` si aplica.
4. Los tests de las piezas movidas van con ellas a `_legado/`.
5. Actualizar el README raíz: borrar las menciones a shadow/relay-worker/rollback como componentes vivos.

## No tocar
`telegram-bridge` (es el canal real: 12.206 mensajes), `deploy/compose.yaml` (FASE 3 lo reescribe; aquí solo se anota que declara servicios que ya no existen), migraciones SQL, `ops/pty-agent` (vivo), `ops/systemd`, `ops/guardias`.

## Gate de aceptación
- `pnpm typecheck && pnpm lint && pnpm build` en verde tras cada commit de movimiento.
- `pnpm test:unit` no peor que antes (los fallos preexistentes de consola son del fichero 21).
- Ninguna referencia rota: `git grep` de cada nombre movido no aparece en código vivo (solo en `_legado/` y docs).
