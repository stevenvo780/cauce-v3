#!/usr/bin/env python3
"""Reemplaza el bloque de sitio consola.humanizar.tech del Caddyfile por una version
con LISTA BLANCA de rutas. Todo /v3/* que no sea superficie de consola se corta en el
borde con 404, sin llegar al gateway.

Uso: patch_caddy.py /etc/caddy/Caddyfile
Idempotente: si ya esta la lista blanca (marcador LISTA-BLANCA-CONSOLA), no hace nada.
"""
import sys
import re

MARK = "LISTA-BLANCA-CONSOLA"

NUEVO = '''consola.humanizar.tech {
  # === %s (2026-08-06) ===
  # Este dominio publica SOLO la superficie que consume la SPA (apps/console/src/api/client.ts
  # y src/features/terminal/api.ts):
  #   /v3/auth/*     login, session, logout  (tiene que ser anonimo: es la puerta)
  #   /v3/status     presencia de la flota   (el gateway ya exige cookie -> 401 sin sesion)
  #   /v3/console/*  todo el plano de consola, incluido terminal/ws, terminal/targets,
  #                  terminal/sessions y terminal/capability (el gateway exige cookie -> 401)
  #
  # El resto de /v3/* es superficie MAQUINA-A-MAQUINA del bus (/v3/messages, /v3/publish,
  # /v3/ack, /v3/heartbeat, /v3/query, /v3/deliveries/*, /v3/connections/*, /v3/accounts/*,
  # /v3/quotas/samples, /v3/ws ...). Los adaptadores la usan por la tailnet contra el gateway
  # (100.64.0.6:8443) y NO pasan por este dominio.
  #
  # Por que lista BLANCA y no negra: el nginx del contenedor presenta su certificado mTLS
  # `console-client` en TODO lo que proxea, asi que cualquier ruta de bus alcanzable desde
  # aca queda autenticada como operador sin cookie ninguna. Medido el 2026-08-06 desde
  # internet y sin sesion: GET /v3/accounts/selection?provider=claude -> 200 con datos reales
  # (rutas de credenciales incluidas) y POST /v3/messages -> 202 publicando como Steven:kant.
  # Una lista negra se queda vieja con la proxima ruta que alguien agregue al gateway; esta
  # falla cerrado.
  #
  # Para revertir: cp del backup Caddyfile.bak-antes-lista-blanca-* y `systemctl reload caddy`.
  @bus_privado {
    path /v3/*
    not path /v3/auth/* /v3/status /v3/console/*
  }

  # `route` conserva el orden escrito (los directivos sueltos se reordenan por la tabla de
  # Caddy). Primero se corta, despues se proxea.
  route {
    respond @bus_privado "not found" 404

    reverse_proxy https://100.64.0.6:8444 {
      # El proxy NO inventa identidad. La persona sale del login de la consola (JWT ->
      # console_users) y el gateway exige sesion para todo /v3/console/*; una cabecera fija aca
      # hacia que la auditoria dijera "steven" entrara quien entrara.
      header_up -X-Cauce-Operator
      transport http {
        tls_insecure_skip_verify
      }
    }
  }
}''' % MARK

def main():
    path = sys.argv[1]
    src = open(path, encoding="utf-8").read()

    if MARK in src:
        print("YA-APLICADO: el marcador %s ya esta en %s" % (MARK, path))
        return 0

    # Bloque de sitio: desde la linea que empieza en columna 0 con el host, hasta la
    # primera linea que sea exactamente "}" en columna 0.
    pat = re.compile(r"^consola\.humanizar\.tech\s*\{.*?^\}", re.S | re.M)
    matches = pat.findall(src)
    if len(matches) != 1:
        print("ABORTA: se esperaba 1 bloque consola.humanizar.tech, hay %d" % len(matches))
        return 1

    out = pat.sub(lambda _m: NUEVO, src, count=1)
    open(path, "w", encoding="utf-8").write(out)
    print("APLICADO sobre %s" % path)
    return 0

if __name__ == "__main__":
    sys.exit(main())
