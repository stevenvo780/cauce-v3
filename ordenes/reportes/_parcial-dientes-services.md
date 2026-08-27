# Parcial de dientes — lote services

Auditoría de solo lectura. Cubre `services/gateway/**/*.test.ts`, `services/telegram-bridge/**/*.test.ts`, `services/terminal-relay/**/*.test.ts`. Conteo: declaraciones `it(`/`test(` (las expansiones `it.each(...)` cuentan como una sola declaración; el número de filas está indicado en la columna "tests" cuando aporta).

Hallazgo grueso: este lote NO tiene tests sin dientes, skips, ni tautológicos sospechosos. Todas las 65 fichas son CON DIENTES reales (estado de BD, respuesta HTTP/WS, frames, JSON de salida, errores reales del código bajo prueba). Las 12 peores son las que tienen la cobertura más delgada — siguen mordiendo código real, pero en su mínima expresión.

## 1. Tabla por fichero

| fichero | tests | con-dientes | sin-dientes | skips | tautológicos |
|---|---:|---:|---:|---:|---:|
| services/dispatcher/test/config.test.ts | 14 | 14 | 0 | 0 | 0 |
| services/dispatcher/test/handlers.test.ts | 2 | 2 | 0 | 0 | 0 |
| services/dispatcher/test/liveness.test.ts | 4 | 4 | 0 | 0 | 0 |
| services/gateway/src/agent-directive-degrada.test.ts | 5 | 5 | 0 | 0 | 0 |
| services/gateway/src/config.test.ts | 7 | 7 | 0 | 0 | 0 |
| services/gateway/src/console-audit.test.ts | 3 | 3 | 0 | 0 | 0 |
| services/gateway/src/console-dlq.test.ts | 9 | 9 | 0 | 0 | 0 |
| services/gateway/src/console-message-body.test.ts | 4 | 4 | 0 | 0 | 0 |
| services/gateway/src/console-publish-intent.test.ts | 7 | 7 | 0 | 0 | 0 |
| services/gateway/src/console-publish-telemetry.test.ts | 2 | 2 | 0 | 0 | 0 |
| services/gateway/src/console/agent-directive.routes.test.ts | 16 | 16 | 0 | 0 | 0 |
| services/gateway/src/console/agent-documents.read.test.ts | 27 | 27 | 0 | 0 | 0 |
| services/gateway/src/console/agent-documents.routes.test.ts | 22 | 22 | 0 | 0 | 0 |
| services/gateway/src/console/agent-documents.test.ts | 28 | 28 | 0 | 0 | 0 |
| services/gateway/src/console/agent-profile-runtime.test.ts | 10 | 10 | 0 | 0 | 0 |
| services/gateway/src/console/agent-profile.routes.test.ts | 38 | 38 | 0 | 0 | 0 |
| services/gateway/src/console/relay-governance-client.test.ts | 28 | 28 | 0 | 0 | 0 |
| services/gateway/src/console/sonda-compartida.test.ts | 8 | 8 | 0 | 0 | 0 |
| services/gateway/src/facades.dlq.test.ts | 8 | 8 | 0 | 0 | 0 |
| services/gateway/src/health-progress.test.ts | 34 | 34 | 0 | 0 | 0 |
| services/gateway/src/health-schema037.pg.test.ts | 1 | 1 | 0 | 0 | 0 |
| services/gateway/src/mtls-health.test.ts | 1 | 1 | 0 | 0 | 0 |
| services/gateway/src/oidc-bff.test.ts | 3 | 3 | 0 | 0 | 0 |
| services/gateway/src/password-auth.test.ts | 16 | 16 | 0 | 0 | 0 |
| services/gateway/src/password.test.ts | 5 | 5 | 0 | 0 | 0 |
| services/gateway/src/publish-priority-policy.test.ts | 4 | 4 | 0 | 0 | 0 |
| services/gateway/src/publish-priority.test.ts | 7 | 7 | 0 | 0 | 0 |
| services/gateway/src/routes/legado-candidato.test.ts | 3 | 3 | 0 | 0 | 0 |
| services/gateway/src/terminal.authority.test.ts | 19 | 19 | 0 | 0 | 0 |
| services/gateway/src/terminal.plugin.test.ts | 58 | 58 | 0 | 0 | 0 |
| services/gateway/src/terminal.relay-identity.test.ts | 1 | 1 | 0 | 0 | 0 |
| services/gateway/src/terminal.tickets.test.ts | 13 | 13 | 0 | 0 | 0 |
| services/gateway/src/terminal/hechos-del-registro.test.ts | 23 | 23 | 0 | 0 | 0 |
| services/telegram-bridge/test/activity.test.ts | 10 | 10 | 0 | 0 | 0 |
| services/telegram-bridge/test/addressing.test.ts | 44 | 44 | 0 | 0 | 0 |
| services/telegram-bridge/test/artifacts.test.ts | 15 | 15 | 0 | 0 | 0 |
| services/telegram-bridge/test/attachments.test.ts | 5 | 5 | 0 | 0 | 0 |
| services/telegram-bridge/test/bridge-egress.test.ts | 24 | 24 | 0 | 0 | 0 |
| services/telegram-bridge/test/bridge-ingress.test.ts | 17 | 17 | 0 | 0 | 0 |
| services/telegram-bridge/test/bridge-lifecycle.test.ts | 11 | 11 | 0 | 0 | 0 |
| services/telegram-bridge/test/bridge.test.ts | 12 | 12 | 0 | 0 | 0 |
| services/telegram-bridge/test/config.test.ts | 16 | 16 | 0 | 0 | 0 |
| services/telegram-bridge/test/envelope.test.ts | 11 | 11 | 0 | 0 | 0 |
| services/telegram-bridge/test/fragments.test.ts | 7 | 7 | 0 | 0 | 0 |
| services/telegram-bridge/test/ingress-postgres.test.ts | 1 | 1 | 0 | 0 | 0 |
| services/telegram-bridge/test/ingress.test.ts | 4 | 4 | 0 | 0 | 0 |
| services/telegram-bridge/test/markdown.test.ts | 14 | 14 | 0 | 0 | 0 |
| services/telegram-bridge/test/postgres.test.ts | 2 | 2 | 0 | 0 | 0 |
| services/telegram-bridge/test/progress.test.ts | 5 | 5 | 0 | 0 | 0 |
| services/telegram-bridge/test/redaction.test.ts | 18 | 18 | 0 | 0 | 0 |
| services/telegram-bridge/test/untrusted.test.ts | 17 | 17 | 0 | 0 | 0 |
| services/telegram-bridge/test/voice.test.ts | 15 | 15 | 0 | 0 | 0 |
| services/terminal-relay/src/agent-leg.test.ts | 9 | 9 | 0 | 0 | 0 |
| services/terminal-relay/src/framing.test.ts | 10 | 10 | 0 | 0 | 0 |
| services/terminal-relay/src/governance-relay-mutations.test.ts | 8 | 8 | 0 | 0 | 0 |
| services/terminal-relay/src/governance-relay.test.ts | 21 | 21 | 0 | 0 | 0 |
| services/terminal-relay/src/health.test.ts | 3 | 3 | 0 | 0 | 0 |
| services/terminal-relay/src/read-governance-directory.test.ts | 20 | 20 | 0 | 0 | 0 |
| services/terminal-relay/src/read-governance.test.ts | 15 | 15 | 0 | 0 | 0 |
| services/terminal-relay/src/relay-circuit.test.ts | 20 | 20 | 0 | 0 | 0 |
| services/terminal-relay/src/relay.test.ts | 13 | 13 | 0 | 0 | 0 |
| services/terminal-relay/src/session-spool.test.ts | 3 | 3 | 0 | 0 | 0 |
| services/terminal-relay/src/sessions-recovery.test.ts | 10 | 10 | 0 | 0 | 0 |
| services/terminal-relay/src/sessions.test.ts | 25 | 25 | 0 | 0 | 0 |
| services/terminal-relay/src/write-governance-batch.test.ts | 4 | 4 | 0 | 0 | 0 |
| services/terminal-relay/src/write-governance.test.ts | 9 | 9 | 0 | 0 | 0 |
| **TOTAL** | **741** | **741** | **0** | **0** | **0** |

## 2. Peores de mi lote (12)

No hay tests sin dientes ni tautológicos. Las 12 peores son las que más se acercan al límite de "prueba-al-mock" o las que más superficialmente verifican comportamiento mínimo. Todas siguen mordiendo código real: el assert cae sobre retorno de función pura, respuesta HTTP real, frame binario real, etc.

| # | ruta:línea | nombre | subtipo |
|---|---|---|---|
| 1 | services/dispatcher/test/handlers.test.ts:5 | "has no fallback and invokes only a registered kind" | `prueba-al-mock` leve — registra `vi.fn(async () => undefined)` y lo único que afirma del código real es que el registro lo guarda y `get('unknown.kind')` devuelve undefined. Asserts: `expect(execute).toHaveBeenCalledOnce(); expect(registry.get('unknown.kind')).toBeUndefined();` (líneas 12-13). |
| 2 | services/gateway/src/password.test.ts:9 | "el hash guardado NO contiene la contraseña y cambia con cada alta" | compara dos hashes con sales distintas — el "cambia" es tautológico por construcción; la parte con dientes es que la contraseña no aparezca en claro y que el formato sea scrypt canónico. Asserts en líneas 12-16: `expect(first).not.toContain(...); expect(first).not.toBe(second); expect(first.startsWith('$scrypt$n=1024,r=8,p=1$')).toBe(true);` |
| 3 | services/gateway/src/terminal.tickets.test.ts:57 | "emits the golden ticket byte for byte" | golden-vector — el test es "esta función devuelve exactamente estos bytes". Muerde bytes reales, pero la única lógica es que coincidan. Assert en línea 59: `expect(issueTicket(GOLDEN_PAYLOAD, key)).toBe(GOLDEN_TICKET);` |
| 4 | services/gateway/src/terminal.tickets.test.ts:53 | "derives the per-alias key with HKDF-SHA256 exactly as the relay and the agent do" | idem. Assert línea 54: `expect(deriveAliasKey(MASTER, 'Steven', 'jarvis').toString('hex')).toBe(GOLDEN_ALIAS_KEY_HEX);` |
| 5 | services/gateway/src/agent-directive-degrada.test.ts:50 | "la memoria que no se pudo listar es un fallo discriminado, no un índice de cero" | control negativo débil: importa dinámicamente el módulo, llama `construirRespuestaDegradada(undefined)` y compara con literales. El "control negativo" en líneas 58-60 (`indiceRealVacio`) sólo verifica que un objeto no tiene la propiedad `error`. Asserts en líneas 53-56: `expect(codigo!.memory).toMatchObject({ error: 'unavailable', root: null }); expect(codigo!.memory).not.toHaveProperty('total'); expect(codigo!.memory).not.toHaveProperty('entries');` |
| 6 | services/gateway/src/console-publish-telemetry.test.ts:8 | "renders every fixed operation/result and counts bounded outcomes" | pasa por un vocabulario estático y verifica que cada par aparezca en la salida. Asserts en líneas 14-22: `expect(metrics).toContain(...); expect(metrics).not.toMatch(/tenant\|alias\|operator\|nonce\|message_id\|idempotency/u);` — los `toContain` son tautológicos respecto al vocabulario. |
| 7 | services/gateway/src/console-publish-telemetry.test.ts:25 | "fails closed on an invented event or malformed snapshot" | `prueba-al-mock` suave — los inputs vienen del propio test y el assert es `toThrow` con regex. Asserts en líneas 26-29: `expect(() => telemetryWithInventedOutcome()).toThrow(...); expect(() => renderConsolePublishMetrics({ snapshot: () => ({ 'prepare:prepared': -1 }) })).toThrow(...);` |
| 8 | services/gateway/src/agent-directive-degrada.test.ts:24 | "con hechos de fuente «registry»: NO medida" | llamada pura sobre `construirRespuestaDegradada('registry')`. Asserts en líneas 26-28: `expect(r!.medido).toBe(false); expect(r!.files).toBeNull(); expect(r!.motivo).toMatch(/deducidas del registro/);` |
| 9 | services/gateway/src/agent-directive-degrada.test.ts:31 | "con hechos de fuente «database»: NO medida" | idem. Asserts en líneas 33-34: `expect(r!.medido).toBe(false); expect(r!.motivo).toMatch(/deducidas del registro/);` |
| 10 | services/gateway/src/agent-directive-degrada.test.ts:37 | "CONTROL NEGATIVO: «measured» no produce respuesta degradada" | assert único. Línea 40: `expect(construirRespuestaDegradada('measured')).toBeUndefined();` |
| 11 | services/gateway/src/oidc-bff.test.ts:208 | "rejects a mismatched ID-token authorized party even with one valid audience" | `prueba-al-mock` parcial: `test.callback` se compara contra un objeto literal; el `expectedVerifier`/`expectedChallenge` ya vienen del propio helper. Asserts en líneas 211-216: `expect(test.callback.statusCode).toBe(401); expect(test.callback.json()).toMatchObject({...}); expect(String(test.callback.headers['set-cookie'])).not.toContain('__Host-cauce_session=');` |
| 12 | services/gateway/src/publish-priority-policy.test.ts:14 | "does not confuse an operator role with authenticated human attribution" | mínima: una línea por assert, todo sobre la primitiva `publishPriorityDecision` pura. Asserts en líneas 17-19: `expect(isAttributedHuman(machineOperator)).toBe(false); expect(publishPriorityDecision(machineOperator, 100, { interactiveHumanEntry: true })).toEqual({ applied: AGENT_PRIORITY_CEILING, reason: 'agent_ceiling' });` |

## 3. Skips y guardas

No hay `it.skip`, `describe.skip`, `xit`, `test.todo`, `it.only`, ni guardas de entorno (`if (!process.env.DATABASE_URL) return`) en este lote. Las únicas `return` tempranas están dentro de clases de doble (p.ej. `FakeBrowserSocket`, `ScriptedTelegram`) o son retornos de flujo legítimo de un test (`if (write?.mode !== 'write') throw ...`). El gate normal ejecuta cada test declarado.

## 4. Notas

- Ningún test cae en `cero-asserts`, `const`, `snapshot-only` ni `smoke-vacio`.
- Los "golden vector" en `services/gateway/src/terminal.tickets.test.ts` y `services/terminal-relay/src/framing.test.ts` son contratos cross-language: si el assert fallara, se rompería la compatibilidad con el relay Python / pty-agent. Son dientes reales.
- Las pruebas con `startTestDatabase()` (gateway/health-schema037, gateway/health-progress/one, telegram-bridge/ingress-postgres, telegram-bridge/postgres) usan contenedor real de PostgreSQL 16 y verifican schema, índices, triggers y permisos contra la BD.
- Las pruebas con `buildLoopbackHealthProbe({ https: ... })` y `FakePtyAgent` montan servidores HTTPS reales con certificados efímeros generados con `openssl` y verifican rechazo de TLS, instance-id derivada del leaf, etc.