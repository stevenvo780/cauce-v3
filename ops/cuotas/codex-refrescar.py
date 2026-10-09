#!/usr/bin/env python3
"""Refresca el token de Codex de un espacio cuota-* (kant 2026-09-27).

Solo para los contenedores cuota-*: su sesion es PROPIA (login --device-auth hecho dentro del
contenedor el 2026-09-17), no la comparte ningun agente de la flota. Verificado el 2026-09-27:
ninguno de los 16 auth.json de la flota en el VPS lleva su refresh_token. Por eso aqui SI se
puede refrescar. La sonda (codex-http-probe.py) sigue sin refrescar nunca: es la misma que se
usa contra CODEX_HOME de la flota, y alli refrescar revocaria la cadena viva.

Sin esto el token muere a los 10 dias del login y la lectura cae (paso el 2026-09-27).
Uso: docker exec -i <espacio> python3 - /home/node/.codex < codex-refrescar.py
Refresca solo si al access token le quedan menos de 3 dias. No imprime secretos.
"""
import base64, json, os, sys, tempfile, time, urllib.request
from datetime import datetime, timezone

home = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.codex')
ruta = os.path.join(home, 'auth.json')
auth = json.load(open(ruta))
tok = auth.get('tokens') or {}

def claims(jwt):
    p = jwt.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))

c = claims(tok['access_token'])
queda = c.get('exp', 0) - time.time()
if queda > 3 * 86400 and '--forzar' not in sys.argv:
    print(json.dumps({'refrescado': False, 'queda_h': round(queda / 3600, 1)}))
    sys.exit(0)

cuerpo = json.dumps({'client_id': c.get('client_id') or 'app_EMoamEEZ73f0CkXaXp7hrann',
                     'grant_type': 'refresh_token', 'refresh_token': tok['refresh_token'],
                     'scope': 'openid profile email'}).encode()
req = urllib.request.Request('https://auth.openai.com/oauth/token', data=cuerpo,
                             headers={'Content-Type': 'application/json'})
try:
    r = json.load(urllib.request.urlopen(req, timeout=30))
except urllib.error.HTTPError as e:
    print(json.dumps({'refrescado': False, 'error': 'HTTP %s' % e.code}))
    sys.exit(1)
for k in ('id_token', 'access_token', 'refresh_token'):
    if r.get(k):
        tok[k] = r[k]
auth['tokens'] = tok
auth['last_refresh'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
fd, tmp = tempfile.mkstemp(dir=home, prefix='.auth-')
with os.fdopen(fd, 'w') as f:
    json.dump(auth, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, ruta)
nuevo = claims(tok['access_token']).get('exp', 0)
print(json.dumps({'refrescado': True, 'rota_refresh': bool(r.get('refresh_token')),
                  'expira': datetime.fromtimestamp(nuevo, timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}))
