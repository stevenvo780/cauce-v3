#!/usr/bin/env python3
"""Provision the least-privilege PostgreSQL logins of migration 052 for one Cauce instance.

For each login it draws 32 random bytes, derives the SCRAM-SHA-256 verifier locally and sends only
the verifier, through psql stdin inside the PostgreSQL container, in one transaction. The URL of
each login is derived from the owner URL (same host, database, sslmode and CA; new user and
password) and published atomically with mode 0400 and the owner of its template. Every login is
verified from an ephemeral runtime container that receives its URL on stdin, and only then are the
compose logins added to the instance env file, after a ``.pre-roles-<stamp>`` copy. No password,
verifier or URL is ever printed, and nothing is written without ``--apply``.

``--rotate-owner`` rotates the owner role once no runtime connects with it: same SCRAM path, a new
owner URL and the PostgreSQL password file rewritten in place, then the healthcheck connection.
"""

from __future__ import annotations

import argparse
import base64
import dataclasses
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse

MAX_URL_BYTES = 16_384
SCRAM_ITERATIONS = 4096
GROUPS = ("cauce_runtime", "cauce_observer")
RUNTIME_APPLICATIONS = ("cauce-v3", "cauce-fleet-host", "cauce-fleet-adoption-drain", "cauce-fleet-auth")
ROLE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
OWNER_CHECK = ('PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql -XAtq -c "SELECT 1" '
               '"host=postgres port=5432 dbname=$POSTGRES_DB user=$POSTGRES_USER sslmode=verify-full '
               'sslrootcert=/run/secrets/postgres_ca"')
ENV_KEY = re.compile(r"^[A-Z_][A-Z0-9_]*$")
PRODUCTION_CONFIG = pathlib.Path("/etc/cauce-v3")
# The dependency scans of configuration and fleet purge read every table of public whose columns match.
ADHOC_SQL = ("SELECT 'adhoc:'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
             "WHERE n.nspname='public' AND c.relkind IN ('r','p') "
             "AND NOT has_table_privilege('cauce_runtime',c.oid,'SELECT') ORDER BY 1;\n")
VERIFY_SCRIPT = """
import { createRequire } from 'node:module';
const pg = createRequire('/app/packages/store/package.json')('pg');
let url = '';
for await (const chunk of process.stdin) url += chunk;
const client = new pg.Client({ connectionString: url.trim(), application_name: 'cauce-role-provision' });
await client.connect();
try {
  const row = (await client.query(`SELECT current_user AS login,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super,
    has_table_privilege(current_user,'platform_admins','INSERT') AS platform_insert,
    (SELECT count(*) >= 0 FROM tenants) AS tenants`)).rows[0];
  process.stdout.write(JSON.stringify(row));
} finally { await client.end(); }
"""


@dataclasses.dataclass(frozen=True)
class Login:
    name: str
    group: str
    limit: int
    secret: str
    env: str | None


# Each limit is the pool max of its consumers plus a margin (runbook §2): a burst queues in the pool
# instead of failing with 53300.
LOGINS = (
    Login("cauce_gateway", "cauce_runtime", 30, "database_url_gateway", "CAUCE_DATABASE_URL_GATEWAY_SECRET_PATH"),
    Login("cauce_dispatcher", "cauce_runtime", 25, "database_url_dispatcher", "CAUCE_DATABASE_URL_DISPATCHER_SECRET_PATH"),
    Login("cauce_bridge", "cauce_runtime", 25, "database_url_bridge", "CAUCE_DATABASE_URL_BRIDGE_SECRET_PATH"),
    Login("cauce_observer_login", "cauce_observer", 5, "database_url_observer", "CAUCE_DATABASE_URL_OBSERVER_SECRET_PATH"),
    Login("cauce_fleet", "cauce_runtime", 20, "database_url_fleet", None),
    Login("cauce_monitor", "cauce_observer", 25, "database_url_monitor", None),
    Login("cauce_backup", "pg_read_all_data", 2, "database_url_backup", None),
)


class ProvisionError(RuntimeError):
    pass


def read_env(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and ENV_KEY.match(key):
            values[key] = value.strip().strip("\r")
    return values


def private_url(path: pathlib.Path) -> tuple[urllib.parse.SplitResult, os.stat_result]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > MAX_URL_BYTES:
        raise ProvisionError(f"{path} must be a private regular file of at most {MAX_URL_BYTES} bytes")
    lines = path.read_text(encoding="utf-8").splitlines()
    parsed = urllib.parse.urlsplit(lines[0].strip() if len(lines) == 1 else "")
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.username or "@" not in parsed.netloc:
        raise ProvisionError(f"{path} does not hold exactly one PostgreSQL URL with a user")
    return parsed, metadata


def login_url(template: urllib.parse.SplitResult, login: str, password: str) -> str:
    host = template.netloc.rpartition("@")[2]
    credentials = f"{urllib.parse.quote(login, safe='')}:{urllib.parse.quote(password, safe='')}"
    return urllib.parse.urlunsplit(template._replace(netloc=f"{credentials}@{host}")) + "\n"


def scram_verifier(password: str) -> str:
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, SCRAM_ITERATIONS)
    stored = hashlib.sha256(hmac.new(salted, b"Client Key", "sha256").digest()).digest()
    server = hmac.new(salted, b"Server Key", "sha256").digest()
    encode = lambda value: base64.b64encode(value).decode("ascii")  # noqa: E731
    return f"SCRAM-SHA-256${SCRAM_ITERATIONS}:{encode(salt)}${encode(stored)}:{encode(server)}"


def psql(container: str, user: str, database: str, sql: str) -> str:
    command = ["docker", "exec", "-i", container, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
               "-v", "VERBOSITY=terse", "-U", user, "-d", database]
    result = subprocess.run(command, input=sql, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        reason = next((line for line in result.stderr.splitlines() if "SCRAM-SHA-256$" not in line), "")
        raise ProvisionError(f"psql failed with status {result.returncode}: {reason[:200]}")
    return result.stdout


def role_sql(login: Login, verifier: str, exists: bool) -> str:
    attributes = (f"LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT "
                  f"CONNECTION LIMIT {login.limit} PASSWORD '{verifier}'")
    if exists:
        return f"ALTER ROLE {login.name} WITH {attributes};\nGRANT {login.group} TO {login.name};\n"
    return f"CREATE ROLE {login.name} WITH {attributes} IN ROLE {login.group};\n"


def stage(directory: pathlib.Path, body: str, owner: os.stat_result) -> pathlib.Path:
    descriptor, name = tempfile.mkstemp(prefix=".provision-", dir=directory)
    try:
        os.fchmod(descriptor, 0o400)
        os.fchown(descriptor, owner.st_uid, owner.st_gid)
        pending = memoryview(body.encode("utf-8"))
        while pending:
            pending = pending[os.write(descriptor, pending):]
        os.fsync(descriptor)
    except BaseException:
        os.unlink(name)
        raise
    finally:
        os.close(descriptor)
    return pathlib.Path(name)


def publish(staged: pathlib.Path, destination: pathlib.Path) -> None:
    os.replace(staged, destination)
    directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def updated_env(text: str, values: dict[str, str]) -> str:
    lines = [line for line in text.splitlines() if line.partition("=")[0].strip().removeprefix("export ") not in values]
    return "\n".join([*lines, *(f"{key}={value}" for key, value in values.items())]) + "\n"


@dataclasses.dataclass(frozen=True)
class Instance:
    env: dict[str, str]
    env_path: pathlib.Path
    owner_path: pathlib.Path
    template: urllib.parse.SplitResult
    owner: os.stat_result
    project: str
    container: str
    directory: pathlib.Path

    def psql(self, sql: str) -> str:
        return psql(self.container, self.env["POSTGRES_USER"], self.env["POSTGRES_DB"], sql)

    def transaction(self, statements: str) -> None:
        self.psql("BEGIN;\nSET LOCAL log_statement='none';\nSET LOCAL log_min_error_statement='panic';\n"
                  "SET LOCAL log_min_duration_statement=-1;\n" + statements + "COMMIT;\n")

    def verify(self, login: Login, password: str) -> None:
        """Host consumers included, every login is checked over the backend network with the owner URL's host:
        the check is about the role, not about the consumer's route."""
        command = ["docker", "run", "--rm", "-i", "--network", f"{self.project}_backend", "--read-only",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node",
                   "-v", f"{self.env['CAUCE_POSTGRES_CA_PATH']}:/run/secrets/postgres_ca:ro",
                   "-e", "PGSSLROOTCERT=/run/secrets/postgres_ca", self.env["CAUCE_RUNTIME_IMAGE"],
                   "--input-type=module", "-e", VERIFY_SCRIPT]
        result = subprocess.run(command, input=login_url(self.template, login.name, password), capture_output=True,
                                text=True, check=False)
        try:
            row = json.loads(result.stdout) if result.returncode == 0 else {}
        except json.JSONDecodeError:
            row = {}
        if row != {"login": login.name, "super": False, "platform_insert": False, "tenants": True}:
            raise ProvisionError(f"{login.name} failed verification (status {result.returncode}); "
                                 f"{self.env_path} is unchanged and the URL files stay for a --rotate rerun")


def instance(args: argparse.Namespace) -> Instance:
    env_path = pathlib.Path(args.env)
    env = read_env(env_path)
    missing = [key for key in ("CAUCE_DATABASE_URL_SECRET_PATH", "POSTGRES_USER", "POSTGRES_DB",
                               "CAUCE_RUNTIME_IMAGE", "CAUCE_POSTGRES_CA_PATH") if not env.get(key)]
    if missing:
        raise ProvisionError(f"{env_path} lacks {', '.join(missing)}")
    if not ROLE.match(env["POSTGRES_USER"]):
        raise ProvisionError("POSTGRES_USER must be a plain role name")
    owner_path = pathlib.Path(env["CAUCE_DATABASE_URL_SECRET_PATH"])
    template, owner = private_url(owner_path)
    directory = pathlib.Path(args.secrets_dir) if args.secrets_dir else owner_path.parent
    project = env.get("COMPOSE_PROJECT_NAME", "")
    if args.target == "clon" and (not args.secrets_dir or not args.container or not project or any(
            path.resolve().is_relative_to(PRODUCTION_CONFIG) for path in (directory, env_path))):
        raise ProvisionError("--target clon requires --container, --secrets-dir and a clone env with "
                             "COMPOSE_PROJECT_NAME, all outside /etc/cauce-v3")
    project = project or "cauce-v3-prod"
    container = args.container or f"{project}-postgres-1"
    return Instance(env, env_path, owner_path, template, owner, project, container, directory)


def provision(args: argparse.Namespace, target: Instance) -> None:
    templates = {login.name: (target.template, target.owner) for login in LOGINS}
    for entry in args.template:
        name, _, path = entry.partition("=")
        if name not in templates or not path:
            raise ProvisionError(f"--template expects LOGIN=PATH for a known login, got {name or entry!r}")
        templates[name] = private_url(pathlib.Path(path))
    selected = [login for login in LOGINS if not args.login or login.name in args.login]
    names = ",".join(f"'{login.name}'" for login in selected)
    groups = ",".join(f"'{group}'" for group in GROUPS)
    inventory = target.psql(f"SELECT 'group:'||rolname FROM pg_roles WHERE rolname IN ({groups});\n"
                            f"SELECT 'login:'||rolname FROM pg_roles WHERE rolname IN ({names});\n").split()
    if any(f"group:{group}" not in inventory for group in GROUPS):
        raise ProvisionError("the cauce_runtime and cauce_observer groups are absent: apply migration 052 first")
    existing = {line.removeprefix("login:") for line in inventory if line.startswith("login:")}
    occupied = [str(target.directory / login.secret) for login in selected if (target.directory / login.secret).exists()]
    if (existing or occupied) and not args.rotate:
        raise ProvisionError("logins or secret files already exist (" + ", ".join(sorted(existing) + occupied)
                             + "); rerun with --rotate and recreate their consumers")
    adhoc = [line.removeprefix("adhoc:") for line in target.psql(ADHOC_SQL).split() if line.startswith("adhoc:")]
    if adhoc:
        print(f"tablas de public sin SELECT para cauce_runtime: {', '.join(adhoc)}")
    hosted = {entry.partition("=")[0] for entry in args.template}
    for login in selected:
        action = "rotar" if login.name in existing else "crear"
        consumer = login.env or ("consumidor del host" if login.name in hosted
                                 else "consumidor del host; sin --template su URL usa el host de compose")
        print(f"{action} {login.name} en {login.group} (limite {login.limit}) -> "
              f"{target.directory / login.secret} [{consumer}]")
    if not args.apply:
        print("ensayo: sin cambios; repite con --apply")
        return
    if adhoc and not {login.name for login in selected} <= existing:
        raise ProvisionError(f"{len(adhoc)} owner-only tables in public would fail the runtime dependency scans "
                             "with 42501; move them out of public before switching (runbook §3)")
    passwords = {login.name: secrets.token_urlsafe(32) for login in selected}
    staged: dict[str, pathlib.Path] = {}
    committed = False
    try:
        for login in selected:
            login_template, login_owner = templates[login.name]
            staged[login.name] = stage(target.directory, login_url(login_template, login.name, passwords[login.name]),
                                       login_owner)
        target.transaction("".join(role_sql(login, scram_verifier(passwords[login.name]), login.name in existing)
                                   for login in selected))
        committed = True
        for login in selected:
            publish(staged[login.name], target.directory / login.secret)
            del staged[login.name]
    finally:
        if not committed:
            for path in staged.values():
                path.unlink(missing_ok=True)
        elif staged:
            print("the roles already carry the new passwords; their unpublished URLs stay in "
                  + ", ".join(f"{name}={path}" for name, path in staged.items()), file=sys.stderr)
    for login in selected:
        target.verify(login, passwords[login.name])
        print(f"verificado {login.name}: login propio, sin superusuario, sin escritura de plataforma")
    compose = {login.env: str(target.directory / login.secret) for login in selected if login.env}
    if compose:
        env_path = target.env_path
        backup = env_path.with_name(f"{env_path.name}.pre-roles-{datetime.datetime.now(datetime.UTC):%Y%m%dT%H%M%SZ}")
        shutil.copy2(env_path, backup)
        env_owner = env_path.stat()
        os.chown(backup, env_owner.st_uid, env_owner.st_gid)
        publish(stage_env(env_path, updated_env(env_path.read_text(encoding="utf-8"), compose), env_owner), env_path)
        print(f"{env_path}: {', '.join(compose)} (copia previa {backup.name})")


def rotate_owner(args: argparse.Namespace, target: Instance) -> None:
    """The PostgreSQL container bind-mounts the password file, so it is rewritten in place: a rename would
    leave its healthcheck reading the old inode."""
    user = target.env["POSTGRES_USER"]
    password_path = pathlib.Path(target.env.get("CAUCE_POSTGRES_PASSWORD_PATH", ""))
    if target.template.username != user or not password_path.is_absolute() or not password_path.is_file():
        raise ProvisionError("--rotate-owner needs an owner URL for POSTGRES_USER and a CAUCE_POSTGRES_PASSWORD_PATH file")
    applications = ",".join(f"'{name}'" for name in RUNTIME_APPLICATIONS)
    runtime = target.psql(f"SELECT count(*) FROM pg_stat_activity WHERE usename=current_user "
                          f"AND application_name IN ({applications});\n").strip()
    if runtime != "0":
        raise ProvisionError(f"{runtime or 'unknown'} runtime connections still use {user}; switch them first")
    print(f"rotar {user}: {target.owner_path} y {password_path} (en el sitio)")
    if not args.apply:
        print("ensayo: sin cambios; repite con --apply")
        return
    password = secrets.token_urlsafe(32)
    staged = stage(target.owner_path.parent, login_url(target.template, user, password), target.owner)
    committed = False
    try:
        target.transaction(f"ALTER ROLE {user} WITH PASSWORD '{scram_verifier(password)}';\n")
        committed = True
        publish(staged, target.owner_path)
    except BaseException:
        if committed:
            print(f"{user} already carries the new password; its unpublished URL stays in {staged}", file=sys.stderr)
        else:
            staged.unlink(missing_ok=True)
        raise
    descriptor = os.open(password_path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        pending = memoryview(password.encode("ascii"))
        while pending:
            pending = pending[os.write(descriptor, pending):]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    check = subprocess.run(["docker", "exec", target.container, "sh", "-c", OWNER_CHECK],
                           capture_output=True, text=True, check=False)
    if check.stdout.strip() != "1":
        raise ProvisionError(f"{user} was rotated but the healthcheck connection fails (status {check.returncode})")
    print(f"verificado {user}: el healthcheck de PostgreSQL entra con la nueva contrasena")


def stage_env(path: pathlib.Path, body: str, owner: os.stat_result) -> pathlib.Path:
    staged = stage(path.parent, body, owner)
    os.chmod(staged, stat.S_IMODE(owner.st_mode))
    return staged


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--env", required=True, help="fichero env de la instancia (prod.env o el del clon)")
    parser.add_argument("--apply", action="store_true", help="aplica; sin esta opcion solo muestra el plan")
    parser.add_argument("--target", choices=("prod", "clon"), default="prod")
    parser.add_argument("--container", help="contenedor de PostgreSQL (por omision <proyecto>-postgres-1)")
    parser.add_argument("--secrets-dir", help="directorio de las URL (por omision el de la URL del propietario)")
    parser.add_argument("--template", action="append", default=[], metavar="LOGIN=PATH",
                        help="URL existente de un consumidor del host para conservar su host y TLS")
    parser.add_argument("--login", action="append", default=[], choices=[login.name for login in LOGINS])
    parser.add_argument("--rotate", action="store_true", help="rota logins o ficheros que ya existen")
    parser.add_argument("--rotate-owner", action="store_true",
                        help="rota la contrasena del rol propietario cuando ningun runtime lo usa")
    args = parser.parse_args(argv)
    try:
        target = instance(args)
        (rotate_owner if args.rotate_owner else provision)(args, target)
    except (ProvisionError, OSError) as error:
        print(f"provision-db-roles: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
