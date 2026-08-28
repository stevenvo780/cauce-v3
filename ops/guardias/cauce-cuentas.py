#!/usr/bin/env python3
"""Alta, baja y reparto de las cuentas de proveedor de la flota.

POR QUE EXISTE
El registro ya estaba en la base desde la migración 010 —`provider_accounts`, el techo
`alias_routing_ceiling` y `agent_account_bindings` con prioridad— pero sólo se podía tocar
escribiendo SQL a mano contra producción. Eso hizo que nadie lo mantuviera: el 2026-08-04 el
registro decía que seis alias usaban una cuenta cuyo archivo, en el disco, no era el que leían.
Un registro que hay que editar a mano es un registro que miente.

QUE NO HACE, A PROPOSITO
No toca credenciales. `credential_ref` es un LOCATOR (una ruta, un nombre de variable, un
identificador de vault); el contenido del archivo no se lee, no se copia y no se imprime nunca.
Añadir una cuenta es registrar dónde vive, no moverla.

LA REGLA QUE HAY QUE RESPETAR AL AÑADIR CUENTAS
Dos contenedores JAMAS deben apuntar al mismo archivo. Compartir la CUENTA está bien —varios
logins independientes de la misma cuenta conviven, está medido—; lo que mata es compartir el
ARCHIVO, porque el refresh token es de un solo uso y el que rota primero deja al resto con uno
gastado. `verificar` es exactamente el chequeo de eso.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "agora-storage"]
PSQL = "docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -At -F'~'"


def consulta(sql: str) -> list[list[str]]:
    """Corre SQL en la base de producción y devuelve filas ya partidas.

    El SQL viaja por stdin y no por la línea de comandos: así no hay que pelearse con el quoting
    de fish (kratos) ni queda la consulta en el historial de nadie.
    """
    hecho = subprocess.run(SSH + [PSQL], input=sql, capture_output=True, text=True, timeout=120)
    if hecho.returncode != 0:
        print("error de la base:", (hecho.stderr or "").strip()[:300], file=sys.stderr)
        raise SystemExit(1)
    return [linea.split("~") for linea in hecho.stdout.strip().splitlines() if linea]


def escapa(valor: str) -> str:
    return "'" + valor.replace("'", "''") + "'"


def listar(_args: argparse.Namespace) -> int:
    cuentas = consulta(
        "select p.id, p.provider, p.enabled, coalesce(p.paused_reason,''), "
        "       p.credential_ref_kind, p.credential_ref, p.label "
        "from provider_accounts p order by p.provider, p.id;"
    )
    print("== CUENTAS ==")
    for c in cuentas:
        estado = "activa" if c[2] == "t" else "DESACTIVADA"
        if c[3]:
            estado += " (pausada: %s)" % c[3][:40]
        print("  %-22s %-8s %-12s %s" % (c[0], c[1], estado, c[5]))
        print("  %-22s %s" % ("", c[6][:88]))

    ligados = consulta(
        "select b.account_id, b.agent_alias, b.priority, b.enabled "
        "from agent_account_bindings b order by b.account_id, b.priority, b.agent_alias;"
    )
    print("\n== QUIEN USA CADA UNA (por prioridad; 0 es la preferida) ==")
    actual = None
    for l in ligados:
        if l[0] != actual:
            actual = l[0]
            print("  %s:" % actual)
        print("     p%-3s %-10s %s" % (l[2], l[1], "" if l[3] == "t" else "(deshabilitado)"))

    sin_respaldo = consulta(
        "select b.agent_alias, count(*) from agent_account_bindings b where b.enabled "
        "group by 1 having count(*) < 2 order by 1;"
    )
    if sin_respaldo:
        print("\n== SIN RESPALDO: una sola cuenta, si se cae quedan mudos ==")
        print("  " + ", ".join(f[0] for f in sin_respaldo))
    return 0


def verificar(_args: argparse.Namespace) -> int:
    """Dos cuentas distintas que apunten al MISMO archivo son la bomba de relojería de siempre."""
    choques = consulta(
        "select credential_ref, count(*), string_agg(id, ', ' order by id) "
        "from provider_accounts where enabled group by 1 having count(*) > 1;"
    )
    if not choques:
        print("OK: ninguna credencial está registrada dos veces.")
    else:
        print("PELIGRO: el mismo archivo registrado en varias cuentas —")
        for c in choques:
            print("  %s  <- %s" % (c[0], c[2]))
    return 1 if choques else 0


def alta(args: argparse.Namespace) -> int:
    consulta(
        "insert into provider_accounts (id, provider, external_account_id, payer_tenant_id, label,"
        " credential_ref_kind, credential_ref, shared_with_pool, enabled) values (%s,%s,%s,%s,%s,'file',%s,false,true)"
        " on conflict (id) do update set label=excluded.label, credential_ref=excluded.credential_ref,"
        " enabled=true, updated_at=now();"
        % (escapa(args.id), escapa(args.proveedor), escapa(args.id), escapa(args.tenant),
           escapa(args.etiqueta), escapa(args.archivo))
    )
    print("cuenta registrada:", args.id, "->", args.archivo)
    return 0


def ligar(args: argparse.Namespace) -> int:
    """Ata un alias a una cuenta. Primero el techo, porque el binding lo referencia."""
    consulta(
        "insert into alias_routing_ceiling (tenant_id, alias, account_id, account_payer_tenant, created_by_tenant)"
        " select p.payer_tenant_id, %s, p.id, p.payer_tenant_id, p.payer_tenant_id from provider_accounts p"
        " where p.id=%s on conflict do nothing;"
        % (escapa(args.alias), escapa(args.cuenta))
    )
    consulta(
        "insert into agent_account_bindings (tenant_id, agent_alias, account_id, priority, enabled)"
        " select c.tenant_id, c.alias, c.account_id, %d, true from alias_routing_ceiling c"
        " where c.alias=%s and c.account_id=%s"
        " on conflict (tenant_id, agent_alias, account_id) do update set priority=excluded.priority,"
        " enabled=true, updated_at=now();"
        % (args.prioridad, escapa(args.alias), escapa(args.cuenta))
    )
    print("ligado: %s -> %s (prioridad %d)" % (args.alias, args.cuenta, args.prioridad))
    return 0


def pausar(args: argparse.Namespace) -> int:
    consulta(
        "update provider_accounts set paused_until=now()+interval '%d hours', paused_reason=%s,"
        " updated_at=now() where id=%s;" % (args.horas, escapa(args.motivo), escapa(args.id))
    )
    print("pausada %s por %d h: %s" % (args.id, args.horas, args.motivo))
    return 0


def baja(args: argparse.Namespace) -> int:
    """Baja = deshabilitar, nunca borrar: el historial de a quién se le cobró no se toca."""
    consulta("update provider_accounts set enabled=false, updated_at=now() where id=%s;" % escapa(args.id))
    print("cuenta deshabilitada (no borrada):", args.id)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Cuentas de proveedor de la flota Cauce V3")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("listar", help="cuentas, quién usa cada una y quién no tiene respaldo").set_defaults(f=listar)
    sub.add_parser("verificar", help="avisa si dos cuentas comparten el mismo archivo").set_defaults(f=verificar)

    a = sub.add_parser("alta", help="registrar una cuenta nueva")
    a.add_argument("id")
    a.add_argument("--proveedor", required=True, choices=["claude", "codex", "gemini", "minimax", "opencode"])
    a.add_argument("--etiqueta", required=True)
    a.add_argument("--archivo", required=True, help="ruta ABSOLUTA del archivo de credencial (locator, no se lee)")
    a.add_argument("--tenant", default="Steven")
    a.set_defaults(f=alta)

    g = sub.add_parser("ligar", help="atar un alias a una cuenta con prioridad (0 = preferida)")
    g.add_argument("alias")
    g.add_argument("cuenta")
    g.add_argument("--prioridad", type=int, default=0)
    g.set_defaults(f=ligar)

    ps = sub.add_parser("pausar", help="sacarla del reparto un rato sin borrarla")
    ps.add_argument("id")
    ps.add_argument("--horas", type=int, default=24)
    ps.add_argument("--motivo", default="cuota agotada")
    ps.set_defaults(f=pausar)

    b = sub.add_parser("baja", help="deshabilitar una cuenta")
    b.add_argument("id")
    b.set_defaults(f=baja)

    args = p.parse_args()
    return args.f(args)


if __name__ == "__main__":
    raise SystemExit(main())
