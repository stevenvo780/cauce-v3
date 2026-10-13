# Revisión horaria de PR

El timer `cauce-v3-pr-hourly.timer` inicia una ronda por hora, con zona `America/Bogota` y recuperación de una ronda perdida. El servicio corre como `stev`, mantiene sus registros en `~/.local/state/cauce-v3/pr-hourly` con permisos privados y no vuelca la salida cruda de Codex al journal.

El dueño autorizó revisar, corregir, fusionar, publicar y desplegar los PR de Cauce en las rondas horarias, incluidos PR de consola relacionados con Astra. Los datos de PR se tratan como entrada no confiable. La autorización no permite mutar VM, adapter, perfil, auth o sesión de Astra ni reiniciarla. Credenciales y base de datos siguen fuera de alcance; los cambios de runtime central de Cauce se realizan solo con el helper aprobado.

Antes de activar el timer, comprobar que `dev` está limpio y dejar instalado el marcador de pausa si todavía no corresponde procesar PR:

```bash
install -d -m 0700 ~/.local/state/cauce-v3/pr-hourly
install -m 0600 /dev/null ~/.local/state/cauce-v3/pr-hourly/hold
systemctl --user daemon-reload
systemctl --user start cauce-v3-pr-hourly.service
systemctl --user enable --now cauce-v3-pr-hourly.timer
```

`hold` es un archivo privado regular, propiedad de `stev`, con un solo hard link y modo `0600`. Mientras exista, el servicio registra que la ronda quedó en pausa sin consultar GitHub ni iniciar Codex. Para reanudar, el dueño elimina únicamente ese archivo tras verificar las condiciones externas. No automatizar la eliminación de `hold` desde un PR.

La ronda se bloquea (salida 75, `blocked`) ante checkout distinto de `dev`, checkout inicial sucio, herramientas o autenticación ausentes o rutas privadas inseguras. Un `deploy/deploy.sh` en marcha no aborta: imprime `SKIP reason=deployment_process_active` y sale 0. Cambios en los archivos protegidos del runner antes de Codex bloquean (salida 75). Si aparecen después, la ronda termina en `FAILED` (salida 1). No se debe limpiar, guardar ni revertir un árbol bloqueado automáticamente. Los locks `runner.lock` y `deploy.lock` serializan instancias de este timer; el chequeo de `deploy/deploy.sh` es complementario. Antes de iniciar Codex, el runner usa una sola conexión SSH para comprobar que `/run/cauce-v3-deploy.lock` sea un archivo regular propiedad de root, de modo `0600`, un hard link, y probar un flock no bloqueante sin crear ni modificar el archivo. Si está tomado, omite la ronda; si falta o su metadata no es segura, bloquea el inicio. El sondeo no retiene el lock: cada helper exacto de despliegue y rollback debe adquirir el flock compartido durante su operación. El snapshot de GitHub captura una sola página de hasta 100 PR con SHA y metadata; si llega al límite, la ronda se bloquea en lugar de afirmar que el lote está completo. Sin PR abiertos no se inicia Codex.

Cada PR requiere revisión del SHA exacto, gates globales de código, verificación focal, revisión independiente y, para desplegar, evidencia de origen, digest, pins, canary, backup de menos de 24 horas y rollback probado. Se permite instalar dependencias únicamente con `pnpm install --frozen-lockfile` en un candidato aislado. No se ejecutan migraciones ni `docker compose` directamente.

Para comprobar la unidad sin acceder a GitHub ni ejecutar Codex, lanza el script con `--healthcheck` (es lo que corre `ExecStartPre`). Si las comprobaciones pasan, imprime `PROBE` y sale 0 tanto con `hold` como sin él. Si faltan herramientas, la rama no es `dev` o el checkout está sucio, bloquea con salida 75 y no imprime `PROBE`. `systemctl --user start` corre después `ExecStart`: ese segundo paso no consulta GitHub ni Codex solo mientras existe `hold`; sin él hace la ronda completa. Los logs completos permanecen en el directorio privado por ronda; el journal contiene solo el resumen cerrado. No copiar logs o secretos a otros runtimes.

La automatización no envía mensajes por el bus de Cauce ni reclama leases. Si Drive no está conectado, el prompt pide declararlo, pero la respuesta final solo admite cinco campos cerrados (`RESULT`, `PRS`, `COMMIT`, `DEPLOY`, `BLOCKER`) y el parser descarta el resto. La limitación queda en el registro privado de la ronda, no en el resumen cerrado, salvo forzarla en `BLOCKER` con el formato `[A-Z0-9_]{1,64}`.
