# Pack de despliegue (T070–T072) — ejecuta el dueño

Preparado 2026-09-27 contra `dev`. Producción, `main`, `deploy.sh` y la BD
productiva solo las toca el dueño: esto es el checklist + la evidencia previa,
no la ejecución.

## Alcance pendiente (T070)

- `main..dev`: **244 commits, 1118 ficheros (+91.372/−22.871)**.
- Por área: packages 321, services 214, console 212, ops 194, tests 86,
  docs 23, .specify 22, .agents 10, scripts 9, deploy 8.
- Última fila de `deploy/HISTORIAL.md`: `20260908T083631Z` (`60788e41`).
- Decisión del dueño: ventana única de HEAD o cortes intermedios. Si corta,
  cada corte escribe su fila en HISTORIAL con sus digests.

## Precondiciones (de `docs/operacion.md`, verificar antes)

1. `HEAD == origin/main` tras integrar; árbol limpio.
2. Backup <24 h (`host-backup` 03:10 UTC + torre 04:30).
3. `instance-id` relay == sha256 del cert; `docker compose config` válido.
4. 0 `terminal_sessions` abiertas; temporizadores revividor/watchdog parados.
5. Gates en verde: `pnpm typecheck && pnpm lint && pnpm test:unit`,
   `ops/scripts/validate.sh`, `pnpm test` completo, e2e en
   `ops/compose.test.yaml` (este spec: 14/14 + suites T030/T040).

## T071 — raspado `cauce-relay` tras desplegar `6cecfb33`

El job existe (`ops/observability/prometheus.yaml`, `cauce-relay` →
`terminal-relay:8085` por DNS-SD, perfil `terminal`). Como el dns_sd en
silencio es falta invisible, verificar explícitamente post-deploy:

```bash
docker compose exec prometheus wget -qO- 'localhost:9090/api/v1/targets?state=active' \
 | python3 -c "import json,sys; [print(t['health'], t.get('lastScrape'), t['labels'].get('__address__')) for t in json.load(sys.stdin)['data']['activeTargets'] if t['labels'].get('job')=='cauce-relay']"
```

Criterio: ≥1 target `up` con scrape reciente cuando el perfil `terminal`
está levantado; si el perfil no está, ausencia documentada (no rojo fantasma).

## T072 — evidencia de cierre

Pegar en HISTORIAL: digests runtime+console, salida `smoke.sh`, e2e 14/14,
`pnpm test`, `validate.sh`, conteo de fences previos preservados y TLS.
Deuda a cero = toda fila pendiente registrada o recortada por el dueño.
