from __future__ import annotations

import ast
import pathlib
import types
import sys
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]


def functions(name: str, scope: dict) -> dict:
    scope["sys"] = sys
    source = OPS / "guardias" / name
    tree = ast.parse(source.read_text())
    declarations = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)], type_ignores=[])
    exec(compile(declarations, str(source), "exec"), scope)
    return scope


class FleetObservationIdentityTests(unittest.TestCase):
    def test_presence_selects_the_wire_alias_and_tenant(self) -> None:
        inventory = {"physical-one": {"tenant": "Equipo_42", "alias": "shared_alias"}}
        wrong = {"tenant_id": "Other", "alias": "shared_alias"}
        expected = {"tenant_id": "Equipo_42", "alias": "shared_alias"}
        state = functions("cauce-estado", {"FLEET": inventory})
        observed = state["presencia"](types.SimpleNamespace(gateway=lambda *_: (200, {"presence": [wrong, expected]})),
                                     "physical-one")
        self.assertEqual(observed[0], expected)

    def test_queue_selects_wire_recipient_and_tenant_without_changing_physical_auth_identity(self) -> None:
        rows = [{"recipient_tenant": "Other", "recipient_alias": "shared_alias", "status": "pending"},
                {"recipient_tenant": "Equipo_42", "recipient_alias": "shared_alias", "status": "pending"}]
        calls = []
        def gateway(alias, path):
            calls.append((alias, path))
            return 200, {"items": rows}
        scope = functions("cauce-sesiones", {"alias_info": lambda _: {"tenant": "Equipo_42", "alias": "shared_alias"},
                                             "gateway": gateway, "VIVAS": {"pending"}})
        scope["alias_info"] = lambda _: {"tenant": "Equipo_42", "alias": "shared_alias"}
        scope["gateway"] = gateway
        queue = scope["cola"]("physical-one")
        self.assertEqual(queue["items"], [rows[1]])
        self.assertEqual(calls, [("physical-one", "/v3/console/queues")])


if __name__ == "__main__":
    unittest.main()
