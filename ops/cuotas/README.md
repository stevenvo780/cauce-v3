# cuotas — medidor de cuotas de IA, integrado en `cauce`

Uso: `cauce cuotas` (desde la torre o la portátil). Abre la TUI que vive en el **host de cuotas**.

- `tui`: lanzador de la TUI en el host de cuotas (`~/.local/bin/cuotas`).
- `compose.yml`, `Dockerfile`, `cuotas`, `cuota-auth`, `leer-cuota*.mjs`, `codex-*.py` y `publicar`: los contenedores `cuota-*` que miden cada cuenta. Viven en `<host-cuotas>:~/cuotas-cli`.
- Las credenciales (`tokens/`) **no** se versionan: quedan en el host de cuotas.

La imagen incluye una copia de los lectores. Tras cambiar `Dockerfile`, `leer-cuota*.mjs` o
`codex-http-probe.py`, copia esas fuentes al directorio del kit en el host de cuotas y
reconstruye `cuota-cli`; actualizar solo el lector del checkout no cambia los contenedores:

```bash
docker build --pull -t cuota-cli:latest .
docker compose -f compose.yml up -d --force-recreate
```

Ejecuta estos comandos desde el directorio del kit durante la ventana autorizada. La
recreación conserva los volúmenes de cada cuenta. No uses `down -v`. Después comprueba
`./cuotas --json`: la detección del flag de refresco tiene un límite de 10 segundos; si falla
o vence, se consulta sin ese flag para conservar la compatibilidad con imágenes antiguas.
