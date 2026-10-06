#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "instances/common"))
from descriptor import InstanceError, load_instance_descriptor


def main():
    descriptor = load_instance_descriptor(sys.argv[1])
    values = [
        descriptor["codeRoot"] + "/ops",
        descriptor["inventoryRoot"] + "/ops",
        descriptor["paths"]["config"] + "/container-aliases",
        "cauce-" + descriptor["instanceId"],
        descriptor["paths"]["config"] + "/alias-host.tsv",
        descriptor["instanceId"],
        descriptor["paths"]["config"] + "/identities",
        descriptor["paths"]["pki"],
    ]
    print("\n".join(values))


if __name__ == "__main__":
    try:
        main()
    except (InstanceError, OSError, ValueError, IndexError) as error:
        print("invalid instance selection: " + str(error), file=sys.stderr)
        raise SystemExit(2) from error
