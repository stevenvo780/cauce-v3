#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  printf '%s\n' 'Ejecutá este paso como root en la terminal del dueño.' >&2
  exit 64
fi
if [[ ! -t 0 || ! -t 1 ]]; then
  printf '%s\n' 'Este paso requiere una persona en una terminal interactiva.' >&2
  exit 64
fi

umask 077
timeout --foreground --signal=TERM --kill-after=5s 595s \
  docker exec -it -u 1000 hospital-agent-openclaw-operator-gateway-1 \
  timeout --foreground --signal=TERM --kill-after=5s 585s \
  openclaw models auth login --provider xai --method device-code

python3 - <<'PY'
import importlib.util
from pathlib import Path
import time

helper = Path('/usr/local/sbin/praxis-supervision-state.py')
spec = importlib.util.spec_from_file_location('praxis_supervision_state', helper)
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)
destination = Path('/var/lib/praxis-supervision/RESUME.json')
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
state.trusted_file(destination.parent, directory=True)
event = state.auth_resume_event('671e16cb7edad5d061afb71a21aef6ca2d8711655bb7999ccffeecfcdba2ba29', time.time())
state.atomic_save(destination, event)
print('Reautenticación terminada; el próximo turno mecánico puede consumir la señal de recuperación.')
PY
