# Logins pendientes del dueño — 29-08-2026 16:40Z

Verificado contra los guards de credenciales y decodificando el vencimiento real de cada
access token (el guard dice "OK" si hay refreshToken, pero un refresh rechazado por el
servidor solo se descubre al usarlo — así murió argos en silencio).

## 1. ~~Codex de argos/kant (ctrl-infra)~~ — HECHO 29-08 17:11Z

Login del dueño verificado (auth.json refrescado), compactación realineada a
`codex/gpt-5.6-sol` y turno E2E ganado por codex (`working`). Nada pendiente aquí.

- Recordatorio general: **NO copiar** el `auth.json` del pool compartido (refresh de un
  solo uso); el descompartidor aísla `~/.codex/auth.json` a propósito — cada contenedor
  necesita SU login.

## 2. ~~Codex de jarvis (claw)~~ — HECHO 29-08 17:39Z

Login del dueño verificado (JWT vence 08-09) y turno E2E forzado a codex ganado
(`success`, `working`). Nada pendiente aquí.

Vencido desde el **14-08** (15 días muerto en silencio; misma clase que el de argos —
lo descubrí decodificando el JWT al preparar este fichero).

El binario no está en el PATH del contenedor (vive dentro del proyecto npm de openclaw);
comando verificado (`codex-cli 0.144.1`):

```sh
docker exec -it -u claw -e HOME=/home/claw claw /home/claw/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openclaw/codex/node_modules/.bin/codex login --device-auth
```

## 3. ~~Antigravity cuenta B (ctrl-infra)~~ — HECHO 29-08

El shim la reporta `account_b_ready: true`: los modelos `@b` ya se anuncian y reparten carga.

El shim la tiene configurada (`AGY_HOME_B=/home/dev/agy-cuenta-b`) pero la sesión no
existe (`account_b_ready: false`). Solo si quieres repartir carga de gemini en 2 cuentas;
el alta es por navegador:

```sh
docker exec -it -u dev ctrl-infra sh -c 'mkdir -p /home/dev/agy-cuenta-b && HOME=/home/dev/agy-cuenta-b agy'
# → login con la cuenta B de Google; al salir, la sesión queda en disco
```

## Vigilar (NO requieren login hoy)

- **claude de kratos+atlas (ws-humanizar)**: access vencido hace ~15 h pero CON
  refreshToken — la doctrina del guard (caso salva) dice que el CLI renueva al usar, y
  kratos contestó hoy a las 14:42Z. Si kratos/atlas empiezan a fallar con auth, este es el
  primer sospechoso.
- **codex de socrates (ws-prizma)**: vence el 02-09; se renueva solo al usarlo. Si socrates
  pasa días sin actividad, puede caer en la misma clase silenciosa.
- Los `TOKEN-LARGO` (jarvis/janus/argos+kant/hegel en claude) son setup-token de 1 año:
  correctos así, sin refresh que hacer.

## Accesos pendientes (no son logins, pero solo tú puedes darlos)

- **ssh stev→kratos**: sigue bloqueando la migración de kant y el rollout PTY de
  kratos/salva (como root sí funciona; como stev no).
- **Perfiles fase 2**: abrir el perfil de cada agente en la consola (empezando por janus
  como canario) para grabar las expectativas de runtime antes de activar
  `CAUCE_NATIVE_PROFILE_CONTEXT=1`.
