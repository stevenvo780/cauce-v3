# cuotas — medidor de cuotas de IA, integrado en `cauce`

Uso: `cauce cuotas` (desde la torre o la portátil). Abre la TUI que vive en **server2**.

- `tui`: lanzador de la TUI en server2 (`~/.local/bin/cuotas`).
- `compose.yml`, `Dockerfile`, `cuotas`, `cuota-auth`, `leer-cuota*.mjs`, `codex-*.py` y `publicar`: los contenedores `cuota-*` que miden cada cuenta. Viven en `server2:~/cuotas-cli`.
- Las credenciales (`tokens/`) **no** se versionan: quedan en server2.
