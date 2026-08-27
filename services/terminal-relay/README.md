# @cauce/terminal-relay

Puente entre el navegador del operador y el pty-agent que corre dentro del contenedor de cada alias.

**Dos piernas:**
- **Agente** (puerto 8445, TLS mutuo): los pty-agent marcan SALIENTE hacia aquí; identidad por fingerprint del certificado contra `pty_agent_identities.json`; frames binarios etiquetados (cabecera 1B tag + 4B longitud; contrato en `tests/terminal-pty/vectors.json`). Un alias = una conexión: un HELLO nuevo expulsa al anterior (`superseded`).
- **Navegador** (puerto 8446, interno): WS proxificado por el nginx de la consola con mTLS; el relay NO valida tickets — los canjea contra el gateway (`/consume`).

**Gobierno:** publica `/v3/terminal/relay/read` (+ `list`, `write`, `write-batch` en HEAD, **aún sin desplegar**) para que el gateway lea/escriba ficheros de gobierno vía pty-agent.

**Peligro conocido:** si conviven varios pty-agent del mismo alias (huérfanos de rollouts), se expulsan mutuamente en bucle y ninguna sesión sobrevive — plan de arreglo en `plan-reestructura/32`. Un tag desconocido hoy mata la conexión entera (se suaviza en `plan-reestructura/21`).

**Probar:** `pnpm test:terminal-pty` (usa un agente FAKE de Node; la cadena con el agente Python real no tiene test automatizado).
