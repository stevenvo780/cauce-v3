# Arnés de interoperabilidad del canal PTY (contrato de cable v1)

Tres equipos implementan el mismo protocolo por separado y sin verse:

| Pieza | Lenguaje | Rol |
|---|---|---|
| `gateway` | TypeScript | emite y canjea tickets, decide autorización, escribe la auditoría |
| `terminal-relay` | TypeScript | multiplexa bytes entre el navegador (WebSocket) y el agente (TLS crudo) |
| `pty-agent` | Python 3, sólo biblioteca estándar | abre la PTY dentro del contenedor destino, en otro host (kratos) |

El core (gateway, dispatcher, consola) vive en `agora-storage`; los contenedores de los
agentes viven en `kratos`. Toda sesión de terminal cruza esa frontera, así que el único
lugar donde las tres implementaciones se encuentran es este directorio. **Si estos tests no
pasan, el canal PTY no se despliega.**

Este arnés no depende del código de ninguna de las tres: implementa el contrato una cuarta
vez (`protocol.mjs`) usando sólo módulos nativos de Node, y compara contra vectores de oro
congelados.

## Cómo se corre

```bash
# todo el arnés (es lo que corre la verificación de integración)
pnpm vitest run tests/terminal-pty

# sólo los vectores de oro: ticket + framing byte a byte
pnpm vitest run tests/terminal-pty/vectors.test.ts

# sólo el circuito: gateway falso + agente falso (+ relay real si está mergeado)
pnpm vitest run tests/terminal-pty/relay-contract.test.ts
```

`pnpm vitest run tests/terminal-pty` funciona con la config de vitest tal como está en la
raíz (no hace falta tocar `vitest.config.ts`: el include por defecto ya toma
`**/*.test.ts`). No hay script en `package.json` para esto a propósito — el `package.json`
de la raíz es territorio de otro módulo; el integrador puede agregar
`"test:terminal-pty": "vitest run tests/terminal-pty"` si lo quiere en la batería general.

Requisitos: Node >= 22, `vitest` y `ws` (ya en el lockfile) y `openssl` en el PATH, que se
usa para fabricar certificados autofirmados en un directorio temporal en tiempo de test.
Ninguna dependencia nueva; `pnpm-lock.yaml` no se toca.

## Qué prueba cada pieza

### `vectors.json` — la fuente de verdad

Vectores congelados del contrato. Cada caso es `{name, kind, input, expected, must_fail}`.
Los tres primeros vienen de la especificación (clave derivada, ticket completo y frame
STDOUT); el resto se generó con el mismo algoritmo para cubrir los bordes: ticket vencido,
ticket que todavía no empieza, un bit dado vuelta en el HMAC, payload manipulado a `uid:0`
conservando la firma, ticket firmado con la clave de otro alias, target de otro alias, target
de otro tenant, frames de longitud 0, frame de longitud máxima (65536), un frame partido en
chunks de 1 byte, dos frames en una sola lectura más un tercero incompleto, un tag
desconocido y una longitud anunciada por encima del máximo.

Los `kind` que entiende el runner: `derive_alias_key`, `canonical_payload`, `mint_ticket`,
`verify_ticket`, `encode_frame`, `decode_frame`, `decode_stream`.

**No los recalcules.** Si tu implementación no reproduce un vector, la que está mal es tu
implementación. Cualquier cambio acá es un cambio de contrato y se anuncia a los tres equipos.

Para las otras dos implementaciones el archivo es directamente consumible:

```python
# pty-agent (Python): mismo archivo, mismo resultado esperado
import json, hashlib, hmac
vectors = json.load(open("tests/terminal-pty/vectors.json"))
```

### `vectors.test.ts` — detecta la divergencia de protocolo

Recorre todos los casos y además recalcula los tres valores de oro **sin usar
`protocol.mjs`**, directamente con `node:crypto`, para que un error del propio arnés no se
autoconfirme. También verifica que el archivo de vectores sigue siendo el congelado (si
alguien lo "mejora", el test lo dice) y que todo byte del 0x00 al 0xff sobrevive un ida y
vuelta por un frame STDIN sin transcodificarse.

### `fake-pty-agent.mjs` — la pierna del agente, sin kratos

Ejecutable Node autónomo que habla como el agente Python contra un relay real: manda
`AGENT_HELLO`, responde `PING` con `PONG`, **verifica el ticket de cada `OPEN` con las mismas
reglas que el agente real** (firma, ventana, sid, tenant, alias, contenedor, generación,
modo) y en vez de abrir una PTY emula un shell trivial.

```bash
RELAY_HOST=127.0.0.1 RELAY_PORT=8600 \
TENANT=Steven ALIAS=jarvis ALIAS_KEY_HEX=<64 hex> \
AGENT_CERT=/tmp/agent.pem AGENT_KEY=/tmp/agent.key AGENT_CA=/tmp/ca.pem \
CONTAINER_ID=claw GENERATION=gen-1 IMAGE_ID=sha256:... RUNTIME_USER=claw RUNTIME_UID=1000 \
node tests/terminal-pty/fake-pty-agent.mjs
```

Comandos del shell emulado: eco de todo lo que llega; `ping` → `pong-<n>`; `size` →
`size:<cols>x<rows>`; `id -un` → el usuario configurado; `hostname` → el contenedor;
`flood` → `AGENT_FLOOD_BYTES` bytes de golpe (para provocar el corte por caudal, 4413);
`exit` → cierra la sesión; Ctrl-C (0x03) → `^C`.

Variables: `RELAY_HOST`, `RELAY_PORT`, `RELAY_SERVERNAME`, `AGENT_CERT`, `AGENT_KEY`,
`AGENT_CA`, `AGENT_TLS_INSECURE=1`, `TENANT`, `ALIAS`, `ALIAS_KEY_HEX`, `CONTAINER_ID`,
`GENERATION`, `IMAGE_ID`, `RUNTIME_USER`, `RUNTIME_UID`, `AGENT_MODES`, `AGENT_BANNER=1`,
`AGENT_ONESHOT=1`, `AGENT_FLOOD_BYTES`, `AGENT_QUIET=1`, `AGENT_SIMULATE_EUID`.

Códigos de salida, idénticos a los del agente real: `0` limpio, `2` configuración inválida,
`3` HELLO rechazado, `4` error de protocolo (tag desconocido, frame fuera de tamaño), `5`
error de transporte, **`78` se niega a correr como root** (`AGENT_SIMULATE_EUID=0` reproduce
el caso sin necesidad de ser root; hay un test que lo cubre). Además, un ticket firmado cuyo
target dice `uid: 0` se contesta con `OPEN_ERR reason=refuses_root`: el PTY nunca corre como
root aunque el gateway lo firme.

Nunca imprime tickets ni claves: sólo nombres, longitudes y un `ticket_fp` de 12 hex.

### `fake-gateway.mjs` — los cuatro endpoints, sin base de datos

Servidor HTTPS autónomo (o HTTP con `GATEWAY_PLAINTEXT=1`) que implementa:

| Endpoint | Comportamiento |
|---|---|
| `POST /v3/terminal/relay/agents` | 200 si el alias está en grants, 403 `not_granted` si no |
| `POST /v3/terminal/relay/sessions/:sid/consume` | canje atómico de un solo uso: **200 la primera vez, 409 `ticket_already_consumed` la segunda**; 401 `ticket_invalid` con la razón; 403 `attribution_required` si un ticket `unattributed:*` apunta a otro tenant |
| `GET /v3/terminal/relay/sessions/:sid/authz` | 200 mientras vive; 403 con `reason` = `revoked` / `ttl_expired` / `unknown_session` / `closed` |
| `POST /v3/terminal/relay/sessions/:sid/close` | 200 y fila de auditoría `terminal.session.close` |

Todos exigen `Authorization: Bearer <RELAY_TOKEN>`. Escribe las filas de auditoría que la
pantalla `/audit` de la consola tiene que mostrar (`terminal.session.request`,
`terminal.session.consume`, `terminal.session.close`) con alias, contenedor, digest de
imagen, generación y el motivo escrito a mano; el ticket nunca entra, sólo su huella.

```bash
GATEWAY_PORT=0 RELAY_TOKEN=... MASTER_KEY_B64=... REVOKE_AFTER_MS=1500 \
node tests/terminal-pty/fake-gateway.mjs
# imprime una línea JSON: {"ready":true,"url":"https://127.0.0.1:PORT","port":PORT,"ca_path":"..."}
```

Variables: `GATEWAY_PORT`, `RELAY_TOKEN`, `MASTER_KEY_B64`, `OPERATOR_TENANT`, `GRANTS`
(lista `tenant:alias` separada por comas), `REVOKE_AFTER_MS` (fuerza el 403 en caliente para
verificar que el relay cierra con 4403), `DOWN_AFTER_MS` + `DOWN_MODE` (`reset` | `timeout` |
`503`, para el fail-closed cuando el gateway es inalcanzable), `GATEWAY_CERT`/`GATEWAY_KEY`,
`GATEWAY_PLAINTEXT=1`.

Como librería expone `startFakeGateway()` con `setGrants([])` (vaciar `grants.json`),
`revokeAll()`, `goDown()`, `restore()`, `audit` y `auditOf(evento)`.

### `relay-contract.test.ts` — el circuito

Dos mitades:

1. **Siempre corre**: el gateway falso y el agente falso se verifican entre sí y contra el
   contrato. Canje único (200 → 409), ticket forjado, vencido y con sid cruzado,
   `attribution_required` para otro tenant, revocación en caliente, `grants.json` vaciado,
   auditoría completa, gateway caído; y del lado del agente: HELLO/ACK, PING/PONG, apertura
   válida, eco byte a byte, `pong-<n>`, Ctrl-C, RESIZE, modo readonly, rechazo de ticket de
   otro alias, vencido, sid repetido (`session_conflict`) y target root, cierre con
   `CLOSED`, aborto ante tag desconocido, y los códigos de salida 78 y 2.
2. **Corre sólo con el relay real mergeado**: attach válido → `ready` y eco; attach sin
   ticket → 4401; primer frame que no es attach → 4400; sin agente conectado → 4404;
   revocación en caliente → 4403; gateway inalcanzable más allá de la gracia → cierre
   fail-closed; salida masiva → 4413; y separación estricta binario/texto hacia el
   navegador. Mientras `services/terminal-relay` no exista, esos siete casos se saltean y el
   test `terminal-relay availability` imprime el motivo exacto.

Para apuntarlo a un relay que todavía no está en su ruta canónica:

```bash
CAUCE_TERMINAL_RELAY_ENTRY=services/terminal-relay/src/main.ts pnpm vitest run tests/terminal-pty
```

Contrato de entorno que el suite le pasa al relay (si el módulo M4 usa otros nombres, se
ajusta acá, es el único lugar que los menciona): `CAUCE_TERMINAL_RELAY_WS_PORT`,
`CAUCE_TERMINAL_RELAY_AGENT_PORT`, `CAUCE_TERMINAL_RELAY_AGENT_TLS_CERT`,
`CAUCE_TERMINAL_RELAY_AGENT_TLS_KEY`, `CAUCE_TERMINAL_RELAY_GATEWAY_URL`,
`CAUCE_TERMINAL_RELAY_GATEWAY_TOKEN`, `CAUCE_TERMINAL_RELAY_GATEWAY_CA`,
`CAUCE_TERMINAL_RELAY_OUTPUT_LIMIT_BYTES`, `CAUCE_TERMINAL_RELAY_GATEWAY_GRACE_MS`,
`CAUCE_TERMINAL_RELAY_AUTHZ_INTERVAL_MS`.

## Recordatorio del contrato

**Framing relay ↔ pty-agent** (socket TLS crudo, el agente marca hacia el relay):
`[tag:1][length:4 big-endian uint32][payload]`, `length <= 65536`.

| Tag | Nombre | Dirección | Payload |
|---|---|---|---|
| `0x01` | AGENT_HELLO | agente → relay | JSON |
| `0x02` | HELLO_ACK | relay → agente | JSON `{ok}` / `{ok:false, reason}` |
| `0x10` | OPEN | relay → agente | JSON `{session_id, ticket, mode, cols, rows}` |
| `0x11` | OPEN_OK | agente → relay | JSON `{session_id, pid}` |
| `0x12` | OPEN_ERR | agente → relay | JSON `{session_id, reason}` |
| `0x20` | STDIN | relay → agente | DATA |
| `0x21` | STDOUT | agente → relay | DATA |
| `0x22` | RESIZE | relay → agente | JSON `{session_id, cols, rows}` |
| `0x30` | CLOSE | relay → agente | JSON `{session_id, reason}` |
| `0x31` | CLOSED | agente → relay | JSON `{session_id, exit_code, signal, reason}` |
| `0x40` | PING | relay → agente | vacío |
| `0x41` | PONG | agente → relay | vacío |

DATA = 36 bytes ASCII del `session_id` (UUID con guiones) + bytes crudos. Un tag desconocido
no se ignora: se cierra la conexión como error de protocolo (4400). La versión se sube, no se
adivina.

**Ticket**: `v1.<b64url(payload_json)>.<b64url(hmac_sha256(k_alias, ascii('v1.'+b64url_payload)))>`,
b64url sin padding. `k_alias = HKDF-SHA256(IKM=master32, salt='cauce-v3/pty-ticket/v1',
info='pty:'+tenant+':'+alias, L=32)`. El orden de las claves del payload es parte del
contrato (`v, sid, op, sub, tgt{tenant, alias, container, generation, image, uid, user},
mode, iat, exp`): se firman los bytes tal cual, así que serializar en otro orden rompe la
firma.

**Navegador ↔ relay** (`/v3/console/terminal/ws`): el primer frame del cliente es
obligatoriamente texto JSON `{"type":"attach", session_id, ticket, cols, rows}`; después
`input` / `resize` / `ping`. Del servidor: la salida del PTY **siempre** en frames binarios,
el control **siempre** en texto JSON (`ready` / `notice` / `closed`).

Códigos de cierre: `4400` protocol_error, `4401` ticket_invalid, `4403` revoked, `4404`
agent_offline, `4408` idle_timeout, `4409` session_conflict, `4413` output_flood, `4423`
ttl_expired, `1011` internal_error.

## Reglas de este directorio

- Sólo Node nativo, `ws` y `vitest`. Nada de dependencias nuevas.
- Todo corre en local con certificados autofirmados en un temporal; no toca producción, ni
  la base, ni el bus, ni kratos.
- Nunca se imprime un secreto: sólo nombres de variable, rutas, longitudes y hashes truncados.
- Tipos con `tsc --noEmit -p tsconfig.json`, nunca `tsc --build` (deja `.js` en el árbol).
