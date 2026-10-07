#!/usr/bin/env python3
"""Delegate storage ownership and bootstrap exclusively to the instance installer."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

# cauce:requiere none


def load_supervision():
    spec = importlib.util.spec_from_file_location("project_supervision", Path(__file__).with_name("praxis-supervision.py"))
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    return supervisor


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "install", "update", "status"))
    parser.add_argument("--descriptor", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).parent.parent / "common"))
    import instance
    try:
        descriptor = instance.load_instance_descriptor(args.descriptor)
        integration = descriptor.get("integrations", {}).get("supervision")
        if integration:
            supervisor = load_supervision()
            try:
                config = supervisor.load_config(Path(integration["config"]))
            except supervisor.SupervisionError as error:
                raise instance.InstanceError(error.code) from error
            if "project_profile" not in config:
                raise instance.InstanceError("supervision integration requires explicit project profile")
            if integration.get("workspace") != config["workspace"]:
                raise instance.InstanceError("supervision workspace differs from descriptor")
            if not Path(config["project_profile"]["acceptance_root"]).is_relative_to(Path(descriptor["paths"]["state"])):
                raise instance.InstanceError("supervision controls escape instance state")
        command = Path(__file__).parent.parent / "common/cauce-instance"
        os.execv(sys.executable, [sys.executable, str(command), args.action, "--descriptor", str(args.descriptor)])
    except (instance.InstanceError, OSError, ValueError) as error:
        print(json.dumps({"status": "rejected", "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
