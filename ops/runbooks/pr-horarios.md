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

La ronda aborta ante checkout distinto de `dev`, checkout inicial sucio, herramientas o autenticación ausentes, rutas privadas inseguras, cambios en los propios archivos protegidos o un despliegue detectado. No se debe limpiar, guardar ni revertir un árbol bloqueado automáticamente. Los locks `runner.lock` y `deploy.lock` serializan instancias de este timer; el chequeo de `deploy/deploy.sh` es complementario. Antes de iniciar Codex, el runner usa una sola conexión SSH para comprobar que `/run/cauce-v3-deploy.lock` sea un archivo regular propiedad de root, de modo `0600`, un hard link, y probar un flock no bloqueante sin crear ni modificar el archivo. Si está tomado, omite la ronda; si falta o su metadata no es segura, bloquea el inicio. El sondeo no retiene el lock: cada helper exacto de despliegue y rollback debe adquirir el flock compartido durante su operación. El snapshot de GitHub captura una sola página de hasta 100 PR con SHA y metadata; si llega al límite, la ronda se bloquea en lugar de afirmar que el lote está completo. Sin PR abiertos no se inicia Codex.

Cada PR requiere revisión del SHA exacto, gates globales de código, verificación focal, revisión independiente y, para desplegar, evidencia de origen, digest, pins, canary, backup de menos de 24 horas y rollback probado. Se permite instalar dependencias únicamente con `pnpm install --frozen-lockfile` en un candidato aislado. No se ejecutan migraciones ni `docker compose` directamente.

Para comprobar la unidad sin acceder a GitHub ni ejecutar Codex, iniciar el servicio con `--healthcheck` de `ExecStartPre`; el resultado `PROBE` confirma herramientas, ruta, rama, limpieza y estado local. Los logs completos permanecen en el directorio privado por ronda; el journal contiene solo el resumen cerrado. No copiar logs o secretos a otros runtimes.

La automatización no envía mensajes por el bus de Cauce ni reclama leases. Si Drive no está conectado al proceso, deja evidencia local y reporta esa limitación en el resumen de la ronda.
