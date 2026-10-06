from __future__ import annotations

import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
import pathlib
import socket
import stat
import subprocess
import tempfile

from descriptor import InstanceError, canonical, overlaps, safe_path

REGISTRY_ROOT = pathlib.Path(os.environ["CAUCE_INSTANCE_REGISTRY_ROOT"]) if os.environ.get("CAUCE_INSTANCE_REGISTRY_ROOT") else None


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def run(command, *, data=None, env=None):
    result = subprocess.run(command, input=data, text=True, capture_output=True, env=env or {**os.environ, "DOCKER_HOST": "unix:///var/run/docker.sock"})
    if result.returncode:
        raise InstanceError(f"command failed: {command[0]} {command[1] if len(command) > 1 else ''}; exit={result.returncode}; {result.stderr[-1200:].strip()}")
    return result.stdout


def atomic_json(path, document, mode=0o600):
    safe_path(str(path))
    fd, name = tempfile.mkstemp(prefix=path.name + ".atomic-", dir=path.parent)
    temporary = pathlib.Path(name)
    os.fchmod(fd, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(document))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def reservation_lock(*, require_shared=False, readonly=False):
    if REGISTRY_ROOT is None:
        raise InstanceError("explicit CAUCE_INSTANCE_REGISTRY_ROOT must select a provisioned shared host registry")
    safe_path(str(REGISTRY_ROOT))
    if require_shared:
        if not REGISTRY_ROOT.is_dir():
            raise InstanceError("shared host registry is not provisioned")
        info = REGISTRY_ROOT.stat()
        if info.st_uid != 0 or info.st_mode & 0o3000 != 0o3000 or info.st_mode & 0o007:
            raise InstanceError("shared registry must be root-owned, setgid, sticky and private to its operator group")
    else:
        REGISTRY_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        if REGISTRY_ROOT.stat().st_uid != os.getuid() or REGISTRY_ROOT.stat().st_mode & 0o077:
            raise InstanceError("test reservation registry must be private and owned")
    flags = os.O_RDONLY if readonly else os.O_RDWR
    if not require_shared:
        flags |= os.O_CREAT
    fd = os.open(REGISTRY_ROOT / "registry.lock", flags | os.O_NOFOLLOW, 0o660)
    try:
        info = os.fstat(fd)
        if require_shared and (info.st_uid != 0 or info.st_gid != REGISTRY_ROOT.stat().st_gid):
            raise InstanceError("shared registry lock identity differs")
        fcntl.flock(fd, fcntl.LOCK_SH if readonly else fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def binds_overlap(first, second):
    a, b = ipaddress.ip_address(first), ipaddress.ip_address(second)
    if a == b or a.is_unspecified or b.is_unspecified:
        return True
    return a.version == 6 and a.ipv4_mapped == b or b.version == 6 and b.ipv4_mapped == a


def conflicts(first, second):
    if first["instanceId"] == second["instanceId"] or first["project"] == second["project"]:
        return True
    if set(first.get("containerNames", [])) & set(second.get("containerNames", [])):
        return True
    if any(overlaps(a, b) for a in first["roots"] for b in second["roots"]):
        return True
    return binds_overlap(first["bindIp"], second["bindIp"]) and bool(set(first["ports"]) & set(second["ports"]))



def read_reservation(filename, *, own=False):
    path = safe_path(str(filename))
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise InstanceError("reservation cannot be opened safely") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
            raise InstanceError("reservation metadata is unsafe")
        if own and info.st_uid != os.getuid():
            raise InstanceError("reservation physical owner differs from operator UID")
        with os.fdopen(fd, "r", closefd=False) as stream:
            document = json.load(stream)
        named = path.lstat()
        if (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise InstanceError("reservation identity changed during its read")
        if not isinstance(document, dict) or type(document.get("installerUid")) is not int or document["installerUid"] != info.st_uid:
            raise InstanceError("reservation declared UID differs from physical owner")
        return document
    except (OSError, ValueError) as exc:
        raise InstanceError("reservation metadata or document cannot be read safely") from exc
    finally:
        os.close(fd)

def check_reservations(plan, update=False):
    wanted = plan["resources"]
    for path in REGISTRY_ROOT.glob("*.json"):
        existing = read_reservation(path)
        if existing["resources"]["instanceId"] == wanted["instanceId"]:
            if existing["installerUid"] != os.getuid():
                raise InstanceError("instance reservation belongs to another operator UID")
            if existing["planHash"] != plan["planHash"] and not (update and existing.get("immutableHash") == plan["immutableHash"]):
                raise InstanceError("immutable instance/descriptor drift")
            continue
        if conflicts(wanted, existing["resources"]):
            raise InstanceError("host resource reservation collides")


def check_ports(resources):
    for port in resources["ports"]:
        address = ipaddress.ip_address(resources["bindIp"])
        sock = socket.socket(socket.AF_INET6 if address.version == 6 else socket.AF_INET)
        try:
            sock.bind((str(address), port))
        except OSError as exc:
            raise InstanceError(f"port unavailable: {port}") from exc
        finally:
            sock.close()


def inspect_resource(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], text=True, capture_output=True, env={**os.environ, "DOCKER_HOST": "unix:///var/run/docker.sock"})
    if result.returncode:
        if "no such" in result.stderr.lower() or "not found" in result.stderr.lower():
            return None
        raise InstanceError(f"cannot inspect Docker {kind}")
    payload = json.loads(result.stdout)
    if len(payload) != 1:
        raise InstanceError("ambiguous Docker identity")
    return payload[0]


def docker_identity(kind, item):
    return item["Id"] if kind == "network" else item["CreatedAt"] + ":" + item["Mountpoint"]


def verify_owned_resources(plan, receipt):
    for name in plan["resources"].get("adapterContainerNames", []):
        if inspect_resource("container", name) is not None:
            raise InstanceError("unknown existing adapter container requires separate explicit ownership proof")
    labels = {"io.cauce.installation": plan["descriptor"]["instanceId"], "io.cauce.owner": receipt["owner"]}
    for service, configuration in plan["compose"]["services"].items():
        item = inspect_resource("container", configuration["container_name"])
        if item is not None:
            actual = item["Config"].get("Labels") or {}
            required = {**labels, "com.docker.compose.project": plan["resources"]["project"], "com.docker.compose.service": service}
            if any(actual.get(key) != value for key, value in required.items()):
                raise InstanceError("unknown existing core container name")
    for kind, names in plan["dockerResources"].items():
        for name in names:
            item = inspect_resource(kind, name)
            registered = receipt["docker"].get(kind + ":" + name)
            if item is None:
                if registered is not None:
                    raise InstanceError("owned Docker resource disappeared")
                continue
            if not all((item.get("Labels") or {}).get(key) == value for key, value in labels.items()):
                raise InstanceError("unknown Docker resource, including empty volume")
            if registered is not None and registered != docker_identity(kind, item):
                raise InstanceError("owned Docker identity drift")
    containers = run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={plan['resources']['project']}"]).split()
    for container in containers:
        item = json.loads(run(["docker", "inspect", container]))[0]
        if item["Config"]["Labels"].get("io.cauce.owner") != receipt["owner"]:
            raise InstanceError("unknown Compose container")
        if item["Config"]["Labels"].get("com.docker.compose.service") == "postgres":
            expected_name = plan["compose"]["volumes"]["cauce_pgdata"]["name"]
            mounts = [mount for mount in item["Mounts"] if mount["Destination"] == "/var/lib/postgresql/data"]
            if len(mounts) != 1 or mounts[0]["Type"] != "volume" or mounts[0]["Name"] != expected_name:
                raise InstanceError("postgres does not mount the receipt-owned fresh volume")


def create_owned_resources(plan, receipt, save):
    for kind, names in plan["dockerResources"].items():
        for name in names:
            item = inspect_resource(kind, name)
            if item is None:
                run(["docker", kind, "create", "--label", f"io.cauce.installation={plan['descriptor']['instanceId']}",
                     "--label", f"io.cauce.owner={receipt['owner']}", name])
                item = inspect_resource(kind, name)
            labels = item.get("Labels") or {}
            if labels.get("io.cauce.owner") != receipt["owner"] or labels.get("io.cauce.installation") != plan["descriptor"]["instanceId"]:
                raise InstanceError("resource ownership changed while creating it")
            registered = receipt["docker"].get(kind + ":" + name)
            identity = docker_identity(kind, item)
            if registered is not None and registered != identity:
                raise InstanceError("resource identity changed while creating it")
            receipt["docker"][kind + ":" + name] = identity
            save()



def managed_output_path(plan, filename):
    path = safe_path(filename)
    inventory = pathlib.Path(plan["descriptor"]["inventoryRoot"]) / "ops"
    state = pathlib.Path(plan["descriptor"]["paths"]["state"])
    if inventory not in path.parents and path not in (state / "writer", state / "writer.state.json"):
        raise InstanceError("file write target is not an accredited generated resource")
    return path


def file_details(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise InstanceError("owned file cannot be opened safely") from exc
    try:
        info = os.fstat(fd)
        named = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or info.st_mode & 0o077 or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise InstanceError("owned file metadata is unsafe")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            sha = hashlib.sha256(stream.read()).hexdigest()
        return {"sha256": sha, "device": info.st_dev, "inode": info.st_ino}
    finally:
        os.close(fd)


def validate_file_write_intent(plan, receipt):
    intent = receipt["stages"].get("fileWriteIntent")
    if intent is None:
        return None
    required = {"path", "temporary", "oldHash", "newHash", "temporaryIdentity", "owner", "installerUid", "planHash"}
    if not isinstance(intent, dict) or set(intent) != required:
        raise InstanceError("invalid durable file write intent")
    if intent["owner"] != receipt["owner"] or intent["installerUid"] != os.getuid() or intent["planHash"] != receipt["planHash"] or receipt["planHash"] != plan["planHash"]:
        raise InstanceError("durable file write identity differs from exact retry plan")
    path = managed_output_path(plan, intent["path"])
    temporary = safe_path(intent["temporary"])
    if temporary.parent != path.parent or not temporary.name.startswith(path.name + ".cauce-write-" + receipt["owner"] + "-"):
        raise InstanceError("temporary file is not accredited by write intent")
    if intent["oldHash"] != receipt["files"].get(str(path)):
        raise InstanceError("durable old file hash differs from receipt")
    if not isinstance(intent["newHash"], str) or len(intent["newHash"]) != 64 or any(c not in "0123456789abcdef" for c in intent["newHash"]):
        raise InstanceError("invalid durable new file hash")
    return intent


def recover_file_write(plan, receipt, save):
    intent = validate_file_write_intent(plan, receipt)
    if intent is None:
        return
    path = pathlib.Path(intent["path"])
    temporary = pathlib.Path(intent["temporary"])
    current = file_details(path)
    staged = file_details(temporary)
    expected_identity = intent["temporaryIdentity"]
    def matches_identity(details):
        return details is not None and {key: details[key] for key in ("device", "inode")} == expected_identity
    if current and current["sha256"] == intent["newHash"] and matches_identity(current):
        if staged is not None:
            raise InstanceError("unexpected duplicate temporary file after replacement")
    else:
        if (intent["oldHash"] is None and current is not None) or (intent["oldHash"] is not None and (current is None or current["sha256"] != intent["oldHash"])):
            raise InstanceError("generated target changed outside its durable intent")
        if not matches_identity(staged) or staged["sha256"] != intent["newHash"]:
            raise InstanceError("owned staged bytes disappeared or changed")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    receipt["files"][str(path)] = intent["newHash"]
    receipt["stages"].pop("fileWriteIntent")
    save()

def verify_receipt(plan, receipt, update=False):
    expected = {"schemaVersion", "instanceId", "companyId", "planHash", "owner", "docker", "files", "stages", "immutableHash"}
    if not isinstance(receipt, dict) or set(receipt) != expected or receipt["schemaVersion"] != 1:
        raise InstanceError("invalid ownership receipt")
    if receipt["instanceId"] != plan["descriptor"]["instanceId"] or receipt["companyId"] != plan["descriptor"]["companyId"] or receipt["immutableHash"] != plan["immutableHash"] or (receipt["planHash"] != plan["planHash"] and not update):
        raise InstanceError("ownership receipt identity drift")
    pending = validate_file_write_intent(plan, receipt)
    for filename, expected_hash in receipt["files"].items():
        if pending is not None and filename == pending["path"]:
            continue
        path = safe_path(filename)
        if not path.is_file() or path.stat().st_uid != os.getuid() or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise InstanceError("owned generated file drift")
