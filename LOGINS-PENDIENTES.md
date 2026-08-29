# Logins pendientes del dueño — 29-08-2026 16:40Z

Verificado contra los guards de credenciales y decodificando el vencimiento real de cada
access token (el guard dice "OK" si hay refreshToken, pero un refresh rechazado por el
servidor solo se descubre al usarlo — así murió argos en silencio).

## 1. URGENTE — Codex de argos/kant (ctrl-infra)

Vencido desde el **25-08**; el refresh lo rechaza el servidor (`auth_permanent`). Es la razón
por la que argos vive en fallback a gemini.

```sh
docker exec -it -u dev ctrl-infra codex login
```

- **NO copiar** el `auth.json` del pool compartido: el refresh token de OAuth es de un solo
  uso; copiarlo rompe la sesión del pool. El descompartidor (`cauce-cred-descompartir`,
  cada 10 min) aísla `~/.codex/auth.json` a propósito desde el 13-08: cada contenedor
  necesita SU login.
- Tras el login, avisar a zeus (o a mí) para **realinear la compactación de argos** de
  `antigravity/gemini-3.1-pro` de vuelta a `codex/gpt-5.6-sol` (como el resto de la flota).

## 2. URGENTE — Codex de jarvis (claw)

Vencido desde el **14-08** (15 días muerto en silencio; misma clase que el de argos —
lo descubrí decodificando el JWT al preparar este fichero).

```sh
docker exec -it -u claw claw codex login
```

## 3. OPCIONAL — Antigravity cuenta B (ctrl-infra)

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
