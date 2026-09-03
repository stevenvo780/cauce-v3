# @cauce/terminal-relay

Puente entre el navegador del operador y el pty-agent que corre dentro del contenedor de cada alias.

**Dos piernas:**
- **Agente** (puerto 8445, TLS mutuo): los pty-agent marcan SALIENTE hacia aquí; identidad por fingerprint del certificado contra `pty_agent_identities.json`; frames binarios etiquetados (cabecera 1B tag + 4B longitud; contrato en `tests/terminal-pty/vectors.json`). Un alias = una conexión: un HELLO nuevo expulsa al anterior (`superseded`).
- **Navegador** (puerto 8446, interno): WS proxificado por el nginx de la consola con mTLS; el relay NO valida tickets — los canjea contra el gateway (`/consume`).

**Modos:** `shell` y `harness` (solo lectura) más `harness_rw`, el TUI escribible. `harness_rw` no abre sin grabación (`CAUCE_TERMINAL_RECORDING_DIR`, asciicast v2 por sesión, 0600), su idle no se rearma con salida ni con el `ping` del navegador, y se cierra con 4410 cuando el gateway informa que el control se soltó. Un `shell` sólo se graba si el dueño enciende `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS=1`; por defecto no se graba.

**Métricas:** `/metrics` en el listener de salud (`CAUCE_TERMINAL_RELAY_HEALTH_PORT`, 8085). Escucha en todas las interfaces de la red de compose, como el del dispatcher, porque Prometheus es otro contenedor y un `bind` a loopback es un target que no puede alcanzar; Compose no publica el puerto al host. Todo agregado: ni tenant, ni alias, ni operador, ni sesión. El job `cauce-relay` se descubre por DNS (`ops/observability/prometheus.yaml`), así que en una pila sin el perfil `terminal` no hay target ni alerta fantasma. Reglas en `ops/observability/alerts.yaml`, grupo `cauce-v3-terminal`.

**Gobierno:** publica `/v3/terminal/relay/read`, `list`, `write` y `write-batch` (`src/governance-relay.ts`, cableado en `src/main.ts`) para que el gateway lea/escriba ficheros de gobierno vía pty-agent.

**Peligro conocido:** si conviven varios pty-agent del mismo alias (huérfanos de rollouts), se expulsan mutuamente en bucle y ninguna sesión sobrevive — mitigación operativa en `docs/operacion.md` §4. Un tag desconocido mata la conexión entera como error de protocolo (4400); no hay tolerancia parcial, así que cada tag nuevo del agente (0x26 INPUT_REFUSED, 0x27 GEOMETRY) tiene que estar en `src/framing.ts` antes de que ningún agente lo emita.

**Probar:** `pnpm test:terminal-pty` (usa un agente FAKE de Node; la cadena con el agente Python real no tiene test automatizado).
