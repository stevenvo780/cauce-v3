from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys

from descriptor import InstanceError, canonical, mutable_roots, safe_path, validate_bootstrap, validate_descriptor
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from resources import digest, run

REQUIRED_SECRET_VARS = {
    "CAUCE_DATABASE_URL_SECRET_PATH", "CAUCE_POSTGRES_PASSWORD_PATH",
    "CAUCE_POSTGRES_CA_PATH", "CAUCE_POSTGRES_SERVER_CERT_PATH", "CAUCE_POSTGRES_SERVER_KEY_PATH",
    "CAUCE_GATEWAY_TLS_CERT_PATH", "CAUCE_GATEWAY_TLS_KEY_PATH", "CAUCE_GATEWAY_TLS_CA_PATH",
    "CAUCE_GATEWAY_CLIENT_CA_PATH", "CAUCE_CONSOLE_TLS_CERT_PATH", "CAUCE_CONSOLE_TLS_KEY_PATH",
    "CAUCE_CONSOLE_TLS_CA_PATH", "CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH",
    "CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH",
}


def source_hash(descriptor, compose):
    code = pathlib.Path(descriptor["codeRoot"])
    paths = [code / "deploy/compose.yaml", code / "deploy/compose.postgres.yaml"]
    paths += sorted((code / "packages/store/migrations").glob("*.sql"))
    paths += sorted((code / "ops/scripts").glob("*.py"))
    paths += sorted((code / "ops/scripts").glob("*.sh"))
    paths += sorted((code / "ops/instances/common").glob("*.py"))
    paths += [code / "ops/instances/common/cauce-instance", code / "ops/schemas/instance-descriptor.schema.json", code / "ops/schemas/alias-manifest.schema.json"]
    paths += [pathlib.Path(entry["config"]) for entry in descriptor.get("integrations", {}).values()]
    if any(not path.is_file() for path in paths):
        raise InstanceError("release source or integration configuration is missing")
    for service in compose["services"].values():
        for mount in service.get("volumes", []):
            if mount["type"] == "bind" and mount.get("read_only") is True:
                source = safe_path(mount["source"])
                if code == source or code in source.parents:
                    if not source.exists():
                        raise InstanceError("readonly release bind is missing")
                    paths += list(source.rglob("*")) if source.is_dir() else [source]
    files = {}
    for path in sorted(set(paths)):
        safe_path(str(path))
        if path.is_file():
            files[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest(files)


def instance_environment(descriptor):
    code = pathlib.Path(descriptor["codeRoot"])
    paths = descriptor["paths"]
    endpoints = descriptor["endpoints"]
    refs = descriptor["identityRefs"]["secretFiles"]
    missing = sorted(REQUIRED_SECRET_VARS - refs.keys())
    if missing:
        raise InstanceError(f"secret references missing: {missing}")
    env = {key: os.environ[key] for key in ("PATH", "HOME", "XDG_RUNTIME_DIR") if key in os.environ}
    env["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    env.update({
        "CAUCE_INSTALLATION_ID": descriptor["instanceId"],
        "CAUCE_UNIT_PREFIX": "cauce-" + descriptor["instanceId"],
        "CAUCE_CODE_ROOT": str(code), "CAUCE_INVENTORY_ROOT": descriptor["inventoryRoot"],
        "CAUCE_CONFIG_ROOT": paths["config"], "CAUCE_STATE_ROOT": paths["state"],
        "COMPOSE_PROJECT_NAME": descriptor["compose"]["project"],
        "CAUCE_PRIVATE_BIND_IP": endpoints["bindIp"],
        "GATEWAY_TLS_PORT": str(endpoints["gatewayPort"]), "CONSOLE_TLS_PORT": str(endpoints["consolePort"]),
        "TERMINAL_RELAY_AGENT_PORT": str(endpoints["relayPort"]),
        "CAUCE_CONSOLE_ORIGINS": ",".join(endpoints["origins"]),
        "CAUCE_AUTH_PROVIDER": "mtls", "POSTGRES_DB": "cauce", "POSTGRES_USER": "cauce",
        "CAUCE_GATEWAY_IDENTITY_DIR": str(pathlib.Path(paths["config"]) / "identities"),
        "CAUCE_TERMINAL_CONFIG_DIR": str(pathlib.Path(paths["config"]) / "terminal"),
        "CAUCE_TELEGRAM_RUNTIME_DIR": str(pathlib.Path(paths["config"]) / "telegram"),
        "CAUCE_MEDIA_RUNTIME_DIR": str(pathlib.Path(paths["state"]) / "media"),
        "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE": str(pathlib.Path(paths["state"]) / "writer"),
        "CAUCE_TERMINAL_RELAY_INSTANCE_ID": "0" * 64,
        "CAUCE_TERMINAL_ENABLED": "0", "CAUCE_TERMINAL_RW_ENABLED": "0",
        "CAUCE_BLOB_API_ENABLED": "1",
    })
    for key, image in descriptor["release"].items():
        variable = {"runtimeImage": "CAUCE_RUNTIME_IMAGE", "consoleImage": "CAUCE_CONSOLE_IMAGE",
                    "postgresImage": "CAUCE_POSTGRES_IMAGE", "otelImage": "CAUCE_OTEL_IMAGE",
                    "prometheusImage": "CAUCE_PROMETHEUS_IMAGE"}[key]
        env[variable] = image
    text = (code / "deploy/compose.yaml").read_text() + (code / "deploy/compose.postgres.yaml").read_text()
    allowed_refs = set(re.findall(r"file:\s*\$\{(CAUCE_[A-Z0-9_]+_(?:PATH|FILE))", text))
    allowed_refs.discard("CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE")
    if set(refs) - allowed_refs:
        raise InstanceError("unknown or reserved secret file reference")
    for variable in re.findall(r"\$\{(CAUCE_[A-Z0-9_]+_(?:PATH|FILE))", text):
        env.setdefault(variable, "/dev/null")
    env.update(refs)
    return env


def bootstrap_artifacts(descriptor, bootstrap):
    exporter = load_exporter(descriptor["codeRoot"])
    from container_alias_lib import validate_container_aliases, validate_system_principals
    from fleet_derive import alias_entry, manifest_doc
    from instance_namespace import validate_unit_path
    from manifest_lib import validate_manifest

    scripts = pathlib.Path(descriptor["codeRoot"]) / "ops/scripts"
    spec = importlib.util.spec_from_file_location("instance_alias_preflight", scripts / "generate-container-aliases.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    source = {"agents": bootstrap["agents"],
              "memberships": [{**row, "enabled": True} for row in bootstrap["memberships"]],
              "rolePolicies": [{"role": role} for role in sorted({row["role"] for row in bootstrap["memberships"]})]}
    try:
        inventory = exporter.snapshot_document(source)
        aliases = json.loads(generator.render(inventory))
        entries = validate_container_aliases(aliases)
        validate_system_principals(aliases)
        for entry in entries.values():
            if entry["harness"] == "hermes":
                raise InstanceError("Hermes requires an explicitly provisioned own runtime inventory before installation")
            for field in ("home", "stateDirectory", "workspace"):
                if field in entry:
                    validate_unit_path(entry[field])
        validator = Draft202012Validator(json.loads((pathlib.Path(descriptor["codeRoot"]) / "ops/schemas/alias-manifest.schema.json").read_text()))
        assignments = {alias: alias_entry(alias, row, {}) for alias, row in inventory["fleet"].items()}
        for alias, row in inventory["fleet"].items():
            for prefix in ("systemd-", "systemd-container-"):
                if len(prefix + descriptor["instanceId"] + "-" + alias) > 128:
                    raise InstanceError("generated consumer instance identifier exceeds 128 characters")
            manifest = manifest_doc(alias, row)
            validator.validate(manifest)
            validate_manifest(manifest, pathlib.Path(alias + ".yaml"), assignments)
    except InstanceError:
        raise
    except (ValueError, KeyError, TypeError, ValidationError) as exc:
        raise InstanceError("bootstrap cannot produce supported canonical inventory and manifests") from exc
    return inventory, aliases


def plan_instance(descriptor):
    descriptor = validate_descriptor(json.loads(canonical(descriptor)))
    bootstrap_path = pathlib.Path(descriptor["identityRefs"]["bootstrap"])
    bootstrap = validate_bootstrap(json.loads(bootstrap_path.read_text()))
    inventory, aliases = bootstrap_artifacts(descriptor, bootstrap)
    env = instance_environment(descriptor)
    code = pathlib.Path(descriptor["codeRoot"])
    compose = json.loads(run(["docker", "compose", "--env-file", "/dev/null", "-f", str(code / "deploy/compose.yaml"),
                              "-f", str(code / "deploy/compose.postgres.yaml"), "config", "--format", "json"], env=env))
    compose["services"] = {key: service for key, service in compose["services"].items() if not service.get("profiles")}
    for key, service in compose["services"].items():
        service.pop("profiles", None)
        service["container_name"] = descriptor["compose"]["project"] + "-" + key + "-1"
        if key != "postgres":
            service.setdefault("read_only", True)
    namespace = "cauce-" + descriptor["instanceId"]
    names = {"volume": [], "network": []}
    for kind, plural in (("volume", "volumes"), ("network", "networks")):
        for name in compose.get(plural, {}):
            physical = namespace + "-" + name.replace("_", "-")
            compose[plural][name] = {"name": physical, "external": True}
            names[kind].append(physical)
    roots = mutable_roots(descriptor)
    actual_ports = []
    for service in compose["services"].values():
        for port in service.get("ports", []):
            if port.get("host_ip") != descriptor["endpoints"]["bindIp"] or port.get("protocol", "tcp") != "tcp":
                raise InstanceError("Compose bind is not covered by descriptor reservation")
            actual_ports.append(int(port["published"]))
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                source = pathlib.Path(mount["source"])
                own = any(pathlib.Path(root) == source or pathlib.Path(root) in source.parents for root in roots)
                shared_code = (code == source or code in source.parents) and mount.get("read_only") is True
                if not own and not shared_code:
                    raise InstanceError("Compose bind escapes own resources or readonly codeRoot")
            elif mount["type"] != "volume" or mount["source"] not in compose["volumes"]:
                raise InstanceError("Compose mount is not an owned resource")
    endpoints = descriptor["endpoints"]
    if set(actual_ports) - {endpoints[key] for key in ("gatewayPort", "consolePort", "relayPort")} or len(actual_ports) != len(set(actual_ports)):
        raise InstanceError("Compose published ports are incomplete or collide")
    resources = {"instanceId": descriptor["instanceId"], "project": descriptor["compose"]["project"],
                 "roots": mutable_roots(descriptor),
                 "adapterContainerNames": sorted({agent["container_name"] for agent in bootstrap["agents"] if agent["enabled"] and not agent["container_name"].startswith(("host:", "vm:"))}),
                 "bindIp": endpoints["bindIp"], "ports": [endpoints[k] for k in ("gatewayPort", "consolePort", "relayPort")]}
    core_names = {resources["project"] + "-" + service + "-1" for service in compose["services"]}
    if core_names & set(resources["adapterContainerNames"]):
        raise InstanceError("adapter container name collides with core Compose container")
    resources["containerNames"] = sorted(core_names | set(resources["adapterContainerNames"]))
    generated = pathlib.Path(descriptor["inventoryRoot"]) / "ops/generated/instance"
    commands = [
        ["docker", "compose", "-p", resources["project"], "-f", str(generated / "compose.json"), "up", "-d", "--wait", "postgres"],
        ["docker", "compose", "-p", resources["project"], "-f", str(generated / "compose.json"), "run", "--rm", "migrator"],
        ["docker", "compose", "-p", resources["project"], "-f", str(generated / "compose.json"), "up", "-d", "--wait",
         "gateway", "dispatcher", "console", "outbox-metrics"],
    ]
    plan = {"schemaVersion": 1, "descriptor": descriptor, "sourceHash": source_hash(descriptor, compose),
            "bootstrapHash": digest(bootstrap), "bootstrap": bootstrap, "bootstrapInventory": inventory,
            "bootstrapAliases": aliases, "environment": env,
            "compose": compose, "dockerResources": names, "resources": resources, "commands": commands}
    plan["immutableHash"] = digest({"descriptor": {key: value for key, value in descriptor.items() if key not in {"release", "codeRoot"}}, "bootstrapHash": plan["bootstrapHash"]})
    plan["planHash"] = digest({key: value for key, value in plan.items() if key != "environment"})
    return plan


def load_exporter(code):
    scripts = pathlib.Path(code) / "ops/scripts"
    sys.path.insert(0, str(scripts))
    spec = importlib.util.spec_from_file_location("instance_fleet_exporter", scripts / "export-fleet-snapshot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
