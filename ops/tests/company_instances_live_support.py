from __future__ import annotations

import datetime as dt
import importlib
import json
import pathlib
import secrets
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

# cauce:requiere none

CODE = pathlib.Path(__file__).resolve().parents[2]
COMMON = CODE / "ops/instances/common"
sys.path.insert(0, str(COMMON))
resources = importlib.import_module("resources")
canonical = importlib.import_module("descriptor").canonical
REQUIRED_SECRET_VARS = importlib.import_module("planning").REQUIRED_SECRET_VARS

IMAGES = {
    "runtimeImage": "sha256:3ffeaaf77766355359fc2aa58349bb7be33b77792059e3e17d27f5ad979558e2",
    "consoleImage": "sha256:e6643b0bb67fa001dd192367a08399b51f7a6f9a4c952ec2118f90894dd36a3c",
    "postgresImage": "postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
    "otelImage": "otel/opentelemetry-collector-contrib@sha256:9c247564e65ca19f97d891cca19a1a8d291ce631b890885b44e3503c5fdb3895",
    "prometheusImage": "prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996",
}
UPDATE_CONSOLE = "cauce-v3-console@sha256:30d72e1fc3d85dcbd7967e543875ba1232a0579539401b2c0b2c0f2c00e8a83f"


def execute(command, *, data=None, timeout=240):
    value = subprocess.run(command, input=data, text=True, capture_output=True, timeout=timeout)
    if value.returncode:
        raise RuntimeError(
            f"{command[0]} {command[1] if len(command) > 1 else ''}: exit={value.returncode}; {value.stderr[-1800:]}"
        )
    return value.stdout


def free_ports():
    sockets = []
    try:
        for _ in range(3):
            value = socket.socket()
            value.bind(("127.0.0.1", 0))
            sockets.append(value)
        return [value.getsockname()[1] for value in sockets]
    finally:
        for value in sockets:
            value.close()


def issue_leaf(folder, name, usages, alternatives):
    key, csr, cert = [folder / (name + suffix) for suffix in (".key", ".csr", ".crt")]
    execute(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(csr),
            "-subj",
            "/CN=" + name,
        ]
    )
    extension = folder / (name + ".extensions")
    extension.write_text(
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage="
        + usages
        + "\nsubjectAltName="
        + alternatives
        + "\n"
    )
    execute(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(csr),
            "-CA",
            str(folder / "ca.crt"),
            "-CAkey",
            str(folder / "ca.key"),
            "-CAcreateserial",
            "-out",
            str(cert),
            "-days",
            "2",
            "-sha256",
            "-extfile",
            str(extension),
        ]
    )
    key.chmod(0o600)
    cert.chmod(0o644)
    return key, cert


def prepare_company(root, letter, release):
    name = "live-" + root.name.removeprefix("company-live-") + "-" + letter
    home = root / letter
    config, pki = home / "config", home / "pki"
    config.mkdir(parents=True, mode=0o700)
    pki.mkdir(mode=0o700)
    execute(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(pki / "ca.key"),
            "-out",
            str(pki / "ca.crt"),
            "-days",
            "2",
            "-subj",
            "/CN=" + name + "-ca",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
        ]
    )
    (pki / "ca.key").chmod(0o600)
    (pki / "ca.crt").chmod(0o644)
    leaves = {}
    for leaf, usage, sans in (
        ("postgres", "serverAuth", "DNS:postgres"),
        ("gateway", "serverAuth", "DNS:gateway,IP:127.0.0.1"),
        ("console", "serverAuth", "DNS:console,IP:127.0.0.1"),
        ("console-client", "clientAuth", "DNS:console-client"),
        ("operador", "clientAuth", "DNS:operador"),
        ("emisor", "clientAuth", "DNS:emisor"),
    ):
        leaves[leaf] = issue_leaf(pki, leaf, usage, sans)
    for key in (leaves["console"][0], leaves["console-client"][0]):
        key.chmod(0o644)
    password = secrets.token_hex(24)
    password_file = config / "postgres-password"
    password_file.write_text(password)
    password_file.chmod(0o600)
    database_file = config / "database-url"
    database_file.write_text(
        "postgres://cauce:" + password + "@postgres:5432/cauce?sslmode=verify-full&sslrootcert=/run/secrets/postgres_ca"
    )
    database_file.chmod(0o600)
    refs = {
        "CAUCE_DATABASE_URL_SECRET_PATH": str(database_file),
        "CAUCE_POSTGRES_PASSWORD_PATH": str(password_file),
        "CAUCE_POSTGRES_CA_PATH": str(pki / "ca.crt"),
        "CAUCE_POSTGRES_SERVER_CERT_PATH": str(leaves["postgres"][1]),
        "CAUCE_POSTGRES_SERVER_KEY_PATH": str(leaves["postgres"][0]),
        "CAUCE_GATEWAY_TLS_CERT_PATH": str(leaves["gateway"][1]),
        "CAUCE_GATEWAY_TLS_KEY_PATH": str(leaves["gateway"][0]),
        "CAUCE_GATEWAY_TLS_CA_PATH": str(pki / "ca.crt"),
        "CAUCE_GATEWAY_CLIENT_CA_PATH": str(pki / "ca.crt"),
        "CAUCE_CONSOLE_TLS_CERT_PATH": str(leaves["console"][1]),
        "CAUCE_CONSOLE_TLS_KEY_PATH": str(leaves["console"][0]),
        "CAUCE_CONSOLE_TLS_CA_PATH": str(pki / "ca.crt"),
        "CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH": str(leaves["console-client"][1]),
        "CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH": str(leaves["console-client"][0]),
    }
    assert REQUIRED_SECRET_VARS <= refs.keys()
    tenant = "Company" + letter.upper()
    room = "room." + letter
    identities = []
    for alias, channel in (("operador", "adapter"), ("emisor", "human")):
        raw = execute(["openssl", "x509", "-in", str(leaves[alias][1]), "-noout", "-fingerprint", "-sha256"])
        fingerprint = raw.strip().split("=", 1)[1].replace(":", "").lower()
        identities.append(
            {
                "certificate_sha256": fingerprint,
                "expires_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat(),
                "principal": {
                    "tenant_id": tenant,
                    "alias": alias,
                    "session_id": name + "-" + alias,
                    "channel": channel,
                    "roles": ["operator"],
                    "permissions": ["read", "route", "control"],
                },
            }
        )
    identity_dir = config / "identities"
    identity_dir.mkdir(mode=0o700)
    (identity_dir / "mtls_identities.json").write_bytes(canonical({"version": 1, "identities": identities}))
    (identity_dir / "token_hashes.json").write_bytes(canonical({"version": 1, "identities": []}))
    workspace = home / "project"
    bootstrap = {
        "schemaVersion": 1,
        "tenants": [{"id": tenant}],
        "rooms": [{"id": room, "tenant_id": tenant}],
        "memberships": [
            {"tenant_id": tenant, "room_id": room, "alias": alias, "role": "operator"}
            for alias in ("operador", "emisor")
        ],
        "agents": [
            {
                "tenant_id": tenant,
                "alias": "operador",
                "harness_id": "codex",
                "enabled": True,
                "container_name": name + "-agent",
                "runtime_user": "stev",
                "home_directory": str(workspace),
                "state_directory": str(workspace / ".local/state/cauce-v3/operador"),
            }
        ],
        "aclEdges": [],
    }
    (config / "bootstrap.json").write_bytes(canonical(bootstrap))
    ports = free_ports()
    descriptor = {
        "schemaVersion": 1,
        "instanceId": name,
        "companyId": tenant,
        "release": dict(release),
        "codeRoot": str(CODE),
        "inventoryRoot": str(home / "inventory"),
        "paths": {key: str(home / key) for key in ("config", "state", "bundles", "pki", "backups", "locks")},
        "compose": {"project": name},
        "endpoints": {
            "bindIp": "127.0.0.1",
            "gatewayPort": ports[0],
            "consolePort": ports[1],
            "relayPort": ports[2],
            "origins": ["https://127.0.0.1:" + str(ports[1])],
        },
        "identityRefs": {"bootstrap": str(config / "bootstrap.json"), "secretFiles": refs},
    }
    location = home / "descriptor.json"
    location.write_bytes(canonical(descriptor))
    return {"descriptor": descriptor, "path": location, "home": home, "leaves": leaves, "tenant": tenant, "room": room}


class Api:
    def __init__(self, company, alias="operador", certificate_company=None):
        self.company = company
        material = certificate_company or company
        context = ssl.create_default_context(cafile=company["descriptor"]["paths"]["pki"] + "/ca.crt")
        key, cert = material["leaves"][alias]
        context.load_cert_chain(cert, key)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), urllib.request.ProxyHandler({})
        )
        self.endpoint = "https://127.0.0.1:" + str(company["descriptor"]["endpoints"]["gatewayPort"])
        self.instance_id = str(uuid.uuid4())
        self.lease = None

    def request(self, method, path, value=None, data=None, headers=None):
        body = json.dumps(value).encode() if value is not None else data
        request = urllib.request.Request(
            self.endpoint + path,
            data=body,
            method=method,
            headers=headers or {"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=10) as reply:
                raw = reply.read()
                return reply.status, json.loads(raw) if "json" in reply.headers.get("Content-Type", "") else raw
        except urllib.error.HTTPError as error:
            code = error.code
            raw = error.read()
            error.close()
            return code, json.loads(raw)

    def hello(self):
        status, self.lease = self.request(
            "POST",
            "/v3/connections/hello",
            {
                "type": "hello",
                "version": "3.0",
                "tenant_id": self.company["tenant"],
                "alias": "operador",
                "instance_id": self.instance_id,
                "capabilities": [],
            },
        )
        if status != 200:
            raise RuntimeError("hello failed: " + str(status) + " " + str(self.lease))

    def heartbeat(self):
        status, value = self.request(
            "POST",
            "/v3/heartbeat",
            {
                "type": "heartbeat",
                "instance_id": self.instance_id,
                "epoch": self.lease["epoch"],
                "connection_token": self.lease["connection_token"],
            },
        )
        if status != 200:
            raise RuntimeError("heartbeat failed: " + str(status) + " " + str(value))

    def query(self):
        status, value = self.request(
            "POST",
            "/v3/deliveries/query",
            {
                "instance_id": self.instance_id,
                "epoch": self.lease["epoch"],
                "connection_token": self.lease["connection_token"],
                "limit": 2,
            },
        )
        if status != 200:
            raise RuntimeError("query failed: " + str(status) + " " + str(value))
        return value["deliveries"]

    def ack(self, delivery, status="done", retryable=False):
        value = {
            "version": "3.0",
            "status": status,
            "instance_id": self.instance_id,
            "epoch": self.lease["epoch"],
            "event_id": str(uuid.uuid4()),
            "claim_token": delivery["claim_token"],
            "attempt": delivery["attempt"],
            "retryable": retryable,
        }
        code, result = self.request("POST", "/v3/deliveries/" + delivery["delivery_id"] + "/ack", value)
        if code != 200:
            raise RuntimeError("ack failed: " + str(code) + " " + str(result))
        if result.get("applied") is not True:
            raise RuntimeError("fresh ACK did not apply: " + str(result.get("receipt")))
        return result


def snapshot_blob_volume(image, volume):
    labels = resources.inspect_resource("volume", volume)["Labels"]
    script = """const fs=require('fs'),crypto=require('crypto'),path=require('path');
const files=[];function walk(relative=''){for(const entry of fs.readdirSync('/snapshot/'+relative,{withFileTypes:true})){
const file=path.posix.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('snapshot symlink');
if(entry.isDirectory())walk(file);else if(entry.isFile()){const bytes=fs.readFileSync('/snapshot/'+file);
files.push({path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.toString('base64')});}
else throw Error('unsupported snapshot entry');}}walk();files.sort((a,b)=>a.path.localeCompare(b.path));
process.stdout.write(JSON.stringify(files));"""
    return json.loads(
        execute(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--label",
                "io.cauce.owner=" + labels["io.cauce.owner"],
                "--label",
                "io.cauce.installation=" + labels["io.cauce.installation"],
                "--user",
                "1000:1000",
                "--mount",
                "type=volume,source=" + volume + ",target=/snapshot,readonly",
                "--entrypoint",
                "node",
                image,
                "-e",
                script,
            ]
        )
    )


def restore_blob_volume(image, volume, files):
    labels = resources.inspect_resource("volume", volume)["Labels"]
    script = """const fs=require('fs'),path=require('path'),crypto=require('crypto');let text='';
process.stdin.setEncoding('utf8');process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{
for(const file of JSON.parse(text)){if(!file.path||path.posix.isAbsolute(file.path)||file.path.split('/').includes('..'))
throw Error('unsafe restore path');const bytes=Buffer.from(file.bytes,'base64');
if(crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('restore digest mismatch');
const target='/restore/'+file.path;fs.mkdirSync(path.dirname(target),{recursive:true});
fs.writeFileSync(target,bytes,{mode:0o600,flag:'wx'});}});"""
    execute(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--label",
            "io.cauce.owner=" + labels["io.cauce.owner"],
            "--label",
            "io.cauce.installation=" + labels["io.cauce.installation"],
            "--user",
            "1000:1000",
            "--mount",
            "type=volume,source=" + volume + ",target=/restore",
            "--entrypoint",
            "node",
            image,
            "-e",
            script,
        ],
        data=json.dumps(files),
    )
