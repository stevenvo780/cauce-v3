# Contrato QA

## Autoritativo real

`runner.mjs --live` usa el protocolo de `packages/protocol`:

- auth dev explícita por headers de transporte; identidad nunca en body publish;
- `POST /v3/messages` con `{room_id,recipients,body,idempotency_key,lane,priority}`;
- WS `/v3/ws`, primer frame `{type:"hello",version:"3.0",tenant_id,alias,instance_id,capabilities:[...]}`;
- delivery y ACK con nombres snake_case, epoch/instance fencing y estados `accepted|started|done|failed`;
- facades `/v3/console/*` para observación/QA.

El runner valida HTTP/WS/PostgreSQL reales y genera JSON/JUnit/SHA. Harness kinds Hermes/OpenCode/Claude/Codex se anuncian como `qa-double`; su proceso/parser/durable store se prueba por separado en `packages/adapter-sdk/test`.

## Mock contract

`contract-runner.mjs --mock` y `mock-server.mjs` conservan el contrato histórico contribuido únicamente para probar el doble. No se despliegan, no sirven como schema del core y sus resultados deben declarar `mode=mock`.

## Fault injection

Restart real solo en un stack descartable con confirmación `ephemeral-only`.
Testcontainers archiva su evidencia por corrida; el release usa exclusivamente
`artifacts/compose-authentic`, donde gateway/PostgreSQL se matan con mecanismos
explícitos y cero skips críticos. Sin Compose, el equivalente docker-run se
clasifica `runtime-authentic` y nunca se promueve a release.
