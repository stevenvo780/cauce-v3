# Mini ambiente realista — adapters de verdad contra la pila de pruebas

Cómo hablar entre harnesses reales (no fake) usando `ops/compose.test.yaml`
desde el host. Verificado con turnos reales de Claude y OpenCode.

## La pila

```bash
docker compose -f ops/compose.test.yaml up -d
curl -s http://127.0.0.1:18080/health/ready   # {"status":"ready"}
```

Dos decisiones difieren del e2e sintético y están fijas en el YAML:

- Red `testnet` con `internal: false`: con `internal: true` docker ignora
  en silencio los `ports:` y ningún adapter del host puede entrar. El binding
  sigue siendo solo-loopback (`127.0.0.1:18080`), así que no hay exposición.
- `CAUCE_ACK_DEADLINE_MS` / `ACK_TIMEOUT_MS` en `600000` (paridad con
  producción): con `50` el adapter real aborta antes de spawnear
  (`ACK_DEADLINE_BUDGET_EXHAUSTED`). El e2e sigue 14/14 con este valor.

## Un adapter real

```bash
cd packages/adapter-sdk   # requiere pnpm build (SDK ya instalado)
CAUCE_ENVIRONMENT=test CAUCE_DEV_AUTH=1 CAUCE_TENANT=Steven \
CAUCE_ALIAS=kant CAUCE_ROOM=grp.steven CAUCE_INSTANCE_ID=mini-1 \
CAUCE_STATE_DIR=/tmp/mini-kant CAUCE_RELAY_URL=ws://127.0.0.1:18080/v3/ws \
node dist/src/bin/claude.js
```

Alias semilla disponibles: Steven `argos jarvis kant socrates`,
Miguel `janus kratos`, Isa `salva`, Jhon `hegel`,
Pablo `dedalo midas seneca vulcano`. Un alias = un lease: dos adapters con
el mismo alias se cercan (`takeover_rejected`); el e2e también usa estos
alias, así que pila realista y e2e van en serie, nunca a la vez.

## Publicar

```bash
curl -s -X POST http://127.0.0.1:18080/v3/messages \
 -H 'content-type: application/json' \
 -H 'x-cauce-tenant: Steven' -H 'x-cauce-alias: kant' -d '{
  "room_id":"grp.steven",
  "recipients":[{"tenant_id":"Steven","alias":"socrates"}],
  "body":{"text":"..."},"idempotency_key":"unico","lane":"interactive","priority":10}'
```

## Matriz verificada

| Harnés | Resultado |
|---|---|
| claude (kant) | turno real, `delivery_end done`, KANT-ACK en sesión (~$0.33) |
| opencode (socrates) | turno real minimax, reply estructurado, done (~$0.008) |
| codex (jarvis) | mecánico OK; el CLI devuelve 401 (re-login del dueño pendiente) |
| grok | sin bin de harnés en el SDK; el CLI no corre headless aquí (ENXIO) |

Costo medido de la verificación completa: < $0.60.
