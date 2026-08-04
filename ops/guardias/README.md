# Guardias de la flota

Scripts de operación que hasta el 2026-08-04 vivían **sólo** en el disco de `kratos` y dentro de un
contenedor, sin versionar. `/datos` es un **RAID 0 de tres NVMe** (`md127`, sin redundancia): si
cae un disco se pierde todo, y con ello estos scripts y las horas de diagnóstico que hay detrás.
Por eso están acá.

Ninguno contiene secretos: leen credenciales pero sólo publican una **huella** —los primeros 10
hex de `sha256(refreshToken)`— que identifica una cuenta sin permitir reconstruirla.

## Qué hay

| Archivo | Dónde va instalado | Qué hace |
|---|---|---|
| `cred-guard.py` | `kratos:~/.local/bin/` | Revisa las 14 credenciales de la flota: quién se quedó sin `refreshToken` y qué credenciales están compartidas entre contenedores |
| `cred-guard.sh` | `kratos:~/.local/bin/` | Envoltorio del anterior: deja estado en `~/.local/state/cred-guard.{txt,log}` |
| `polidin-guard.sh` | `kratos:~/.local/bin/` | Repone el túnel `ws-zeus:12222 → 10.88.88.31:22` cuando muere |
| `systemd/*.timer`, `systemd/*.service` | `kratos:~/.config/systemd/user/` | Disparan los dos guardias (credenciales cada 30 min, túnel cada 2 min) |
| `contenedor/polidin-fwd.sh` | `ws-zeus:/home/dev/` | El túnel en sí; corre **dentro** del contenedor |
| `cauce-kratos.sh` | `kratos:~/.local/bin/cauce` | El CLI de verdad de la flota |
| `cauce-envoltorio-local.sh` | `<contenedor>:~/.local/bin/cauce` | Envoltorio que hace el `ssh kratos` por vos |
| `cauce-huerfanas.sh` | `<contenedor>:~/.local/bin/` | Lista lo que pidió una PERSONA y se perdió sin respuesta |
| `telegram-bridge.override.yaml` | `agora-storage:/etc/cauce-v3/compose-overrides/` | Monta el parche que apaga la redacción de la ingesta |

## Por qué los guardias viven en kratos y no donde corre lo que vigilan

Los contenedores `ws-*` / `claw*` **no tienen cron ni systemd**: un proceso auxiliar que muere ahí
dentro no lo repone nadie, y el síntoma no dice "falta un proceso" —dice `Connection refused` o
`HTTP 000`—. `kratos` sí tiene systemd de usuario con `Linger=yes`, así que el guardián vive ahí y
alcanza al contenedor por `docker exec`. Pasó dos veces en 48 h: el túnel de Polidinámica y el shim
de Antigravity, los dos caídos días sin que nadie lo notara.

## Restaurar después de una pérdida de disco

```sh
# en kratos, con el repo clonado
install -m755 ops/guardias/cred-guard.py    ~/.local/bin/
install -m755 ops/guardias/cred-guard.sh    ~/.local/bin/
install -m755 ops/guardias/polidin-guard.sh ~/.local/bin/
install -m755 ops/guardias/cauce-kratos.sh  ~/.local/bin/cauce
install -m644 ops/guardias/systemd/*        ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cred-guard.timer polidin-guard.timer
```

Y dentro de `ws-zeus`: `install -m755 ops/guardias/contenedor/polidin-fwd.sh /home/dev/`.

**Comprobá el efecto, no el `systemctl start`.** Matá el proceso a propósito y verificá que el
guardián lo repone; para el túnel, el banner por TCP crudo prueba la cadena entera sin autenticar
(y sin gastar un intento contra `fail2ban`, que banea a la flota entera a los 3 fallos):

```sh
exec 3<>/dev/tcp/172.26.0.7/12222; read -t 8 linea <&3; echo "$linea"   # -> SSH-2.0-OpenSSH_...
```

## Lo que este directorio NO cubre

- El parche compilado que monta `telegram-bridge.override.yaml`
  (`agora-storage:/etc/cauce-v3/patches/telegram-bridge-redaction.js`) es un **artefacto**: sale de
  `services/telegram-bridge/src/redaction.ts`, que sí está versionado. Se regenera compilando; no se
  guarda el binario.
- Las credenciales. A propósito: se rehacen con un login por agente, nunca copiando el archivo de
  otro —copiarlo es exactamente lo que dejó a `janus` y a `claw-iza` sin `refreshToken`.
