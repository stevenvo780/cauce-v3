# Dossier FASE 3 — preparación verificada del despliegue

Generado 2026-08-27 por 26 agentes de solo lectura contra el repo, la base productiva y el host, con refutación adversarial de las 12 migraciones. **Nada de esto se ha ejecutado.** La ventana se corre CON el dueño presente.

Ficheros: `migraciones.md` (las 12, veredicto a veredicto) · `compose-canonico.md` (qué debe tener el compose único) · `pty-huerfanos.md` (kill-list exacta) · `pre-ventana-codigo.md` (código a arreglar ANTES de la ventana).

## La conclusión en 5 líneas

1. Las 12 migraciones 026–037 se aplican **TODAS, en una sola transacción** (así funciona el runner). NO saltarse 036/037: son requisito de readiness del gateway nuevo (`health.ts` las sondea).
2. Hoy la tanda **abortaría con certeza en la 034** (3 sesiones de terminal de julio abiertas) y en el arranque posterior por 3 fail-closed del compose. Todos tienen remedio exacto (abajo).
3. `main` NO es superconjunto de producción: 2 parches vivos en `/etc/cauce-v3/patches/` no están en main (regex base64, pie de fan-in). **Reconstruir desde main sin portarlos reproduce dos incidentes cerrados.** Ver `pre-ventana-codigo.md`.
4. El bucle PTY (92% del tráfico) se apaga matando 12 huérfanos concretos — puede hacerse HOY, sin esperar la ventana. Sin arreglar el launcher, **reaparece en el próximo rollout**.
5. Los 4 runtimes distintos que conviven hoy se unifican con el primer `up -d` canónico: es un cambio grande de código + esquema a la vez. La ventana debe asumirlo y tener el backup verificado antes.

## Notas de health
La readiness productiva recibe `wakePumpTelemetry` y exige, en este orden, los contratos 015 → 032 → 033 → 034 → 035 → 036 → 037 → 031; con producción aún en 024, el gateway nuevo queda `not_ready` hasta aplicar atómicamente 026–037.

## Orden de la ventana (propuesto)

**Antes (sin ventana, cualquier día):**
1. `pre-ventana-codigo.md` completo en main (regex, fan-in, Dockerfile, compose canónico, launcher PTY) con gate verde.
2. Matar los 12 pty-agents huérfanos (`pty-huerfanos.md`) y verificar churn ≈ 0 local.
3. Decisiones del dueño (sección siguiente) tomadas y escritas.

**La ventana (con el dueño):**
4. Backup de BD verificado (restore drill sobre contenedor efímero).
5. Datos: cerrar/revocar las 3 `terminal_sessions` abiertas de julio (bloqueante B1); resolver la lista de flota de 029 según decisión.
6. `prod.env`: añadir `CAUCE_TERMINAL_RELAY_INSTANCE_ID=749f8af81ce316c6e28c3c7ac200640ea1b918ac12b653193864f5d61f4c520b` (B2), rutas de `gateway_relay_client_*` (B3), borrar las 3 líneas rancias de relay-cert.
7. Construir imágenes desde main (con Dockerfile arreglado y parches portados), etiquetadas con el commit.
8. Migrar: la tanda 026–037 completa (una transacción; si algo revienta, rollback automático y se investiga sin prisa).
9. `docker compose up -d --wait` con el compose canónico único (adiós overrides, adiós /opt).
10. Smoke del efecto real: mensaje A→B `done`; `GET .../documents` ≠ 404; **editar un fichero desde la API y leerlo cambiado dentro del contenedor**; sesión TUI viva >60 s.
11. Registrar el deploy (fecha, commit, digests, smoke) en `deploy/HISTORIAL.md`.

## ENSAYO GENERAL EJECUTADO (27-08 tarde) — la ventana ya no es teoría

Contra un CLON de la base productiva (pg_dump 183MB, prod intocada y verificada intacta al cierre):
- **La tanda 026–037 completa: 2,4–3,3 SEGUNDOS de SQL** (ciclo entero clonar+B1+migrar ≈ 50 s). Una sola transacción confirmada empíricamente (12 applied_at idénticos). Idempotente.
- **Ruptura deliberada ensayada**: sin el remedio B1, revienta en la 034 exactamente como predijo el dossier — rápido (3,9 s), error explícito, **rollback impecable verificado** (esquema queda en 024, cero residuos): se aplica B1 y se relanza sin re-clonar.
- B1 = exactamente las 3 filas previstas (ids verificados).
- **Consola horneada y probada**: build 32 s, imagen 79,5MB nginx no-root, arranca, sirve 200, y el bundle CONTIENE el editor (`documents/` + `create_if_absent`). Imagen etiquetada `ensayo-fase3-console` lista para la ventana. (Nota día D: su nginx exige que `gateway` resuelva en la red — comportamiento esperado del proxy_pass.)
- **Veredicto: la ventana puede contar con <1 minuto de migración**; el coste real es backup + ciclo de servicios.

## Decisiones que solo el dueño puede tomar

| # | Decisión | Contexto |
|---|---|---|
| D1 | **Flota declarada de 029 — ENSAYADA, es DOBLE**: (a) deshabilita 3 (Jhon/heraclito, Jhon/tales, Miguel/gaia — fila y FKs preservadas) y (b) **DA DE ALTA 4 agentes nuevos del tenant Pablo** (dedalo/codex, midas y seneca/openclaw, vulcano/claude — enabled=true; flota 14→18, 15 enabled). Los 4 de Pablo nacen SIN perfil (la 026 siembra antes; no rompe nada, pero no publican perfil hasta dárselo). ¿Aplicar tal cual (3 fuera + Pablo dentro), o editar la lista del SQL? | ensayo + `migraciones.md` §029 |
| D2 | **Alertmanager**: el prometheus.yaml nuevo trae alertas de alertmanager pero el servicio no está en el compose. ¿Se despliega con receptor Telegram (7 variables a aprovisionar) o se recortan esas reglas? Sin decidir, `CauceAlertmanagerDown` (critical) queda encendida para siempre. | `compose-canonico.md` §6 |
| D3 | **Desde dónde corre el deploy**: ¿el compose corre desde el repo (`/datos/workspaces/zeus/cauce-v3`) o se sigue copiando a `/opt`? Cambia el source de 4 binds. Recomendación: desde el repo — una fuente. | `compose-canonico.md` §5 |
| D4 | ¿Bloque B de huérfanos (heraclito/tales, churn cero, alias ya fuera del mapa) se mata también? | `pty-huerfanos.md` |
| D5 | El bucle de `dedalo`/`salva` viene de OTRO host: hace falta el mismo censo allí. ¿Cuándo? | `pty-huerfanos.md` |

## Nota post-mudanza deploy/ (27-08 noche, commit f4ba129)
Los digests de dominio CAMBIARON por la mudanza (source-digest.py hashea rutas relativas): runtime `94137da8…` → `c3537bd0…`, console `0b792f640…` → `006d79b7…`. NO es deriva de código — es la mudanza `deploy/{runtime,console,postgres}/`. Quien compare el digest del árbol contra la imagen de prod verá diferencia por esto. qa:runtime-packaging PASÓ tras la mudanza (33 migraciones dentro de la imagen): el contrato in-image `/app/deploy/*` quedó intacto.
