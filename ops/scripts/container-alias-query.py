#!/usr/bin/env python3
from __future__ import annotations

import argparse
import pathlib
import sys

from container_alias_lib import FIELDS, load_container_aliases
from fleet_derive import load_fleet_assignments
from fleet_runtime_inventory import inventory_root, resolve_runtime_key


class AliasArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, add_help=False, **kwargs)
        self.add_argument('-h', '--help', action='help', help='Muestra esta ayuda y termina.')
        self._positionals.title = 'argumentos'
        self._optionals.title = 'opciones'

    def format_help(self):
        return super().format_help().replace('usage: ', 'Uso: ', 1)

    def format_usage(self):
        return super().format_usage().replace('usage: ', 'Uso: ', 1)

    def error(self, _message):
        self.print_usage(sys.stderr)
        self.exit(2, 'Argumentos del selector de alias inválidos; usa --help.\n')


def failure_message(error: Exception) -> str:
    message = str(error)
    if message.startswith('ambiguous wire alias; select TENANT/ALIAS:'):
        return 'El alias es ambiguo; indica TENANT/ALIAS para elegir su empresa.'
    if message.startswith('runtime identity is not declared:'):
        return 'El alias no figura en el inventario aplicado; comprueba su estado en la consola.'
    if 'applied-fleet.json' in message:
        return 'No se pudo verificar applied-fleet.json; revisa el inventario aplicado antes de reintentar.'
    if message.startswith('desired fleet ') and 'digest' in message:
        return 'No se pudo verificar el digest del inventario aplicado; revisa su generación antes de reintentar.'
    return 'No se pudo verificar el alias o el inventario aplicado; revisa la empresa, la generación y los permisos.'


def main() -> int:
    parser = AliasArgumentParser(description="Resuelve identidades físicas o alias de flota por empresa.")
    parser.add_argument("selector", help="Clave física o selector TENANT/ALIAS del inventario aplicado.")
    parser.add_argument("--ops-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--runtime-key", action="store_true")
    mode.add_argument("--identity", action="store_true")
    mode.add_argument("--route", action="store_true")
    mode.add_argument("--supervisor", action="store_true")
    args = parser.parse_args()
    try:
        root = inventory_root(args.ops_root)
        if (args.runtime_key or args.identity or args.route) and (root / "flota.json").exists():
            aliases = load_fleet_assignments(root, resolve_runtime=False, allow_empty=True)
        else:
            aliases = load_container_aliases(root, resolve_runtime=False, allow_empty=True)
        key = resolve_runtime_key(args.selector, aliases)
        entry = aliases[key]
        if args.runtime_key:
            print(key)
        elif args.identity:
            print("\t".join((key, entry["tenant"], entry.get("alias", key))))
        elif args.route:
            host = entry.get("dockerHost", "local")
            print("local" if host == "local" else f"ssh:{entry['systemdUser']}@{host}")
        else:
            print("\t".join(entry[field] for field in FIELDS))
            if args.supervisor:
                print(sum(candidate["container"] == entry["container"] for candidate in aliases.values()))
                print(entry.get("workspace", ""))
                print(entry.get("alias", key))
    except (KeyError, OSError, ValueError) as error:
        print('cauce: no se pudo resolver el alias. ' + failure_message(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
