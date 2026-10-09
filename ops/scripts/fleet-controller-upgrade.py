#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from fleet_controller_upgrade_lib import (
    Abort,
    Rewriter,
    contained_links,
    directory_fd,
    dumps,
    mkdir_owned,
    owned_tree,
    python_closure,
    require_root,
    restore_configs,
    run,
    safe_read,
    say,
    sha256_file,
    snapshot,
    staged_sha256,
    verify_pins,
    wait_until,
    write_new,
)

RELEASE_RE = re.compile(r'[0-9a-f]{40}')
OPS_DIRECTORIES = ('cli', 'container-runtime', 'schemas', 'scripts')
OPS_ENTRIES = ('cli/fleet-executor.py', 'cli/fleet-authority-issuer.py', 'cli/provider-login.py',
               'cli/fleet-provider-hook.py', 'cli/fleet-runtime-rebind.py', 'container-runtime/cauce-container-runtime.py')
REBIND = 'ops/cli/fleet-runtime-rebind.py'
CONFIGS = ('authority.v1.json', 'controller.v1.json', 'executor.server.v1.json', 'auth.server.v1.json')
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'PYTHONDONTWRITEBYTECODE': '1', 'HOME': '/root'}


def current_root(args):
    body, _ = safe_read(args.controller / 'controller.env', private=True)
    values = [line.split('=', 1)[1].strip().strip('"\'') for line in body.decode().splitlines()
              if line.startswith('CAUCE_FLEET_PROJECT_ROOT=')]
    if len(values) != 1:
        raise Abort('controller.env must declare CAUCE_FLEET_PROJECT_ROOT exactly once')
    root = pathlib.Path(values[0])
    if root.parent != args.tools_base or not RELEASE_RE.fullmatch(root.name):
        raise Abort('CAUCE_FLEET_PROJECT_ROOT is not a release tools root')
    if any(not (root / part).is_dir() for part in ('app', 'ops', 'adapter')):
        raise Abort('the current tools root is incomplete')
    return root


def verify_image(args):
    pattern = re.compile(r'^' + re.escape(args.runtime_image_variable) + r'=(.*)$')
    body, _ = safe_read(args.runtime_image_from, private=True, maximum=1_048_576)
    declared = [match.group(1).strip().strip('\'"') for match in map(pattern.match, body.decode().splitlines()) if match]
    if len(declared) != 1 or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}', declared[0]) is None:
        raise Abort('the declared runtime image must be unique and pinned by digest')
    pinned = declared[0].rpartition('@')[2]
    template = '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
    info = json.loads(run(['docker', 'image', 'inspect', '--format', template, declared[0]]).stdout)
    if info['revision'] not in (args.release, args.release[:8]):
        if not args.rehearse:
            raise Abort('the runtime image revision is not the target release')
        say('  [rehearsal] runtime image revision differs from the rehearsed release')
    if info['id'] != pinned and not any(item.rpartition('@')[2] == pinned for item in info['digests'] or []):
        raise Abort('the local image differs from the declared digest')
    run(['docker', 'run', '--rm', '--network', 'none', '--workdir', '/app', '--entrypoint', 'node', info['id'],
         'deploy/runtime-package-smoke.mjs'], timeout=600)
    say(f"  runtime image {info['id'][:19]} revision {info['revision']}: runtime-package-smoke passed")
    return info['id']


def check_ops_source(args):
    top = args.ops_source
    if any(not (top / 'ops' / directory).is_dir() for directory in OPS_DIRECTORIES):
        raise Abort('--ops-source must be the root of an export of the release with ops/{cli,container-runtime,schemas,scripts}')
    marker = top / '.release-sha'
    if marker.is_file():
        if safe_read(marker)[0].decode().strip() != args.release:
            raise Abort('.release-sha of --ops-source differs from the release')
    elif (top / '.git').exists():
        if run(['git', '-C', str(top), 'rev-parse', 'HEAD']).stdout.strip() != args.release:
            raise Abort('HEAD of --ops-source is not the release')
    elif not args.rehearse:
        raise Abort('--ops-source without .git requires a .release-sha file')
    return top / 'ops'


def ops_file_set(old_ops, source_ops):
    wanted = {str(item.relative_to(old_ops)) for item in old_ops.rglob('*') if item.is_file() and '__pycache__' not in item.parts}
    added = set()
    for entry in OPS_ENTRIES:
        if not (source_ops / entry).is_file():
            raise Abort('the release ops lacks the entrypoint ' + entry)
        added |= set(python_closure(source_ops, entry)) - wanted
    present = {name for name in wanted if (source_ops / name).is_file()}
    return sorted(present | added), sorted(added), sorted(wanted - present)


def bundle_digest(python, runtime, bundle):
    output = run([python, '-B', str(runtime), 'bundle-digest', str(bundle)], cwd='/', env=CLEAN_ENV).stdout.strip()
    if re.fullmatch(r'sha256:[0-9a-f]{64}', output) is None:
        raise Abort('bundle-digest returned an unexpected value')
    return output


def install_tools(args, ctx, image_id, work):
    new_root = args.tools_base / args.release
    source_ops = check_ops_source(args)
    bundle = args.adapter_bundle
    if bundle.is_symlink() or not bundle.is_dir():
        raise Abort('--adapter-bundle must be a directory')
    runtime = source_ops / 'container-runtime/cauce-container-runtime.py'
    digest = bundle_digest(ctx['python'], runtime, bundle)
    if args.expected_adapter_digest and args.expected_adapter_digest != digest:
        raise Abort('the adapter bundle digest differs from --expected-adapter-digest')
    ctx['adapter_digest'] = digest
    names, added, dropped = ops_file_set(ctx['old_root'] / 'ops', source_ops)
    ops_mode = {name: 0o755 if name.endswith(('.py', '.sh')) else 0o644 for name in names}
    desired_ops = {name: ('f', ops_mode[name], sha256_file(source_ops / name)) for name in names}
    stage = work / 'app-extract'
    container = run(['docker', 'create', '--network', 'none', '--label', 'io.cauce.v35.role=runtime-extraction', image_id]).stdout.strip()
    try:
        run(['docker', 'cp', container + ':/app', str(stage)], timeout=600)
    finally:
        run(['docker', 'rm', container], check=False)
    contained_links(stage)
    if not (stage / 'services/gateway/dist/fleet/main.js').is_file() or not (stage / 'deploy/runtime-package-smoke.mjs').is_file():
        raise Abort('the extracted app lacks the expected files')
    desired_app = snapshot(stage)
    if new_root.exists():
        installed_ops = {str(item.relative_to(new_root / 'ops')): ('f', stat.S_IMODE(item.lstat().st_mode), sha256_file(item))
                         for item in (new_root / 'ops').rglob('*') if item.is_file() and '__pycache__' not in item.parts}
        problems = [label for label, differs in (
            ('app', snapshot(new_root / 'app') != desired_app), ('ops', installed_ops != desired_ops),
            ('adapter', bundle_digest(ctx['python'], runtime, new_root / 'adapter') != digest)) if differs]
        if problems:
            raise Abort(f"{new_root} exists and differs from the release in: {', '.join(problems)}")
        say(f'  {new_root} already exists and is byte-identical; reused')
        ctx['tools_created'] = False
        return new_root
    mkdir_owned(args.tools_base)
    ctx['tools_created'] = True
    mkdir_owned(new_root)
    shutil.copytree(stage, new_root / 'app', symlinks=True)
    owned_tree(new_root / 'app', normalize=True)
    mkdir_owned(new_root / 'ops')
    for name in names:
        target = new_root / 'ops' / name
        for parent in reversed([item for item in target.parents if item.is_relative_to(new_root / 'ops')]):
            mkdir_owned(parent)
        write_new(target, safe_read(source_ops / name, maximum=134_217_728)[0], 0, 0, ops_mode[name])
    shutil.copytree(bundle, new_root / 'adapter', symlinks=True)
    owned_tree(new_root / 'adapter', normalize=False)
    contained_links(new_root / 'adapter')
    if bundle_digest(ctx['python'], new_root / 'ops/container-runtime/cauce-container-runtime.py', new_root / 'adapter') != digest:
        raise Abort('the installed adapter bundle changed its digest')
    say(f'  installed {new_root}: app {len(desired_app)} entries, ops {len(names)} files '
        f'(+{len(added)} import closure, {len(dropped)} dropped), adapter {digest}')
    return new_root


def shared_mounts_on(policy, root):
    return sorted(name for name, row in policy.get('shared_containers', {}).items()
                  if any(str(mount.get('Source', '')).startswith(str(root) + '/') for mount in row.get('mounts', [])))


def plan_configs(args, ctx, new_root):
    old_root, rewriter, changes = ctx['old_root'], Rewriter(ctx['old_root'], new_root, ctx['adapter_digest']), {}
    ctx['log'] = rewriter.log

    def load_json(name):
        body, info = safe_read(args.controller / name, private=True)
        document = json.loads(body)
        if dumps(document) != body:
            raise Abort(name + ' is not in canonical form (indent=2 + LF); it is not rewritten')
        return document, body, (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))

    documents = {}
    for name in CONFIGS:
        document, body, metadata = load_json(name)
        if name == 'executor.server.v1.json' and args.release != old_root.name and shared_mounts_on(document, old_root):
            raise Abort('shared containers mount the current release and cannot be recreated by the executor: '
                        + ', '.join(shared_mounts_on(document, old_root)))
        document = rewriter.paths(document, name)
        if name == 'executor.server.v1.json':
            rewriter.hook_closure(document, new_root / 'ops', name)
        rewriter.pins(document, name)
        if name == 'controller.v1.json':
            command = document['authority_command']
            if pathlib.Path(command['policy_file']) != args.controller / 'authority.v1.json':
                raise Abort('controller.v1.json points to another authority policy')
            authority = changes[args.controller / 'authority.v1.json'][1]
            rewriter.pin(name, command, 'policy_sha256', hashlib.sha256(authority).hexdigest())
        documents[name] = document
        changes[args.controller / name] = (body, dumps(document), metadata)
    for filename, private in ((args.controller / 'controller.env', True), (args.unit, False)):
        body, info = safe_read(filename, private=private)
        text = body.decode()
        rewriter.log.extend([(filename.name, 'path')] * text.count(str(old_root)))
        changes[filename] = (body, text.replace(str(old_root), str(new_root)).encode(), (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)))
    if args.release != old_root.name:
        if any(old_root.name.encode() in after for _, after, _ in changes.values()):
            raise Abort('a rewritten file still references the previous release')
        stray = [item.name for item in sorted(args.controller.iterdir()) if item.is_file() and not item.is_symlink()
                 and item not in changes and item.name != 'database-url' and '.pre-upgrade-' not in item.name
                 and old_root.name.encode() in item.read_bytes()]
        if stray:
            raise Abort('unmanaged files reference the previous release: ' + ', '.join(stray))
    ctx['changes'], ctx['documents'] = changes, documents


def executor_capabilities(ctx, new_root, policy):
    command = [ctx['python'], '-B', str(new_root / 'ops/cli/fleet-executor.py'), '--policy', str(policy), '--capabilities']
    return run(command, cwd='/', env=CLEAN_ENV).stdout.encode()


def rebind_containers(args, ctx, policy, release, *, include_running=False, dry_run=False):
    command = [ctx['python'], '-B', str(ctx['new_root'] / REBIND), '--policy', str(policy), '--release-root', str(release)]
    command += ['--include-running'] if include_running else []
    command += ['--dry-run'] if dry_run or args.simulate_apply else []
    result = run(command, check=False, cwd='/', env=CLEAN_ENV, timeout=1800)
    if result.returncode:
        raise Abort('container rebind failed: ' + (result.stderr.strip().splitlines() or ['no diagnostic'])[-1][:300])
    receipt = json.loads(result.stdout)
    say(f'  containers -> {release.name[:12]}: ' + ', '.join(f'{key} {len(receipt[key])}' for key in
        ('rebound', 'deferred', 'current', 'refused', 'shared')))
    for row in receipt['deferred']:
        say(f"    deferred (running adapter; rebound at its next start or stop): {row['container']} on {row['release'][:12]}")
    for row in receipt['refused']:
        say(f"    refused (left untouched): {row['container']}: {row['reason']}")
    return receipt


def validate_candidates(args, ctx, new_root, work):
    ctx['pin_count'] = verify_pins(new_root, ctx['documents'].values())
    candidate = work / 'candidate'
    candidate.mkdir(mode=0o700)
    policy = candidate / 'executor.server.v1.json'
    write_new(policy, ctx['changes'][args.controller / 'executor.server.v1.json'][1], 0, 0, 0o600)
    produced = executor_capabilities(ctx, new_root, policy)
    current, _ = safe_read(args.capability, owners=gateway_owners(args))
    new_document, old_document = json.loads(produced), json.loads(current)
    if new_document.get('available') is not True:
        raise Abort('the release executor reports available != true for the candidate policy')
    if new_document.get('placements') != old_document.get('placements'):
        if not args.accept_capability_change:
            raise Abort('announced placements change against the current capability (use --accept-capability-change if intended)')
        say('  WARNING: placements change; accepted by --accept-capability-change')
    ctx['capability_new'], ctx['capability_changed'] = produced, produced != current
    say(f"  candidate policy: available=true, {ctx['pin_count']} pins verified, "
        f"capability.v1.json {'changes' if ctx['capability_changed'] else 'unchanged'}")
    say('  container plan (running containers are listed as deferred until probed):')
    plan = rebind_containers(args, ctx, policy, new_root, dry_run=True)
    shutil.rmtree(candidate)
    blocked = sorted(row['container'] for row in plan['refused'] if row.get('release') == ctx['old_root'].name)
    if blocked:
        raise Abort('containers on the release in service cannot be migrated; fix or purge them first: ' + ', '.join(blocked))


def gateway_owners(args):
    # The gateway reads its fleet config as its own uid and requires private files, so that directory is gateway-owned.
    return (0, args.gateway_uid)


def write_configs(args, ctx, stamp):
    pending = [(filename, before, after, metadata, (0,)) for filename, (before, after, metadata) in ctx['changes'].items() if before != after]
    if ctx['capability_changed']:
        body, info = safe_read(args.capability, owners=gateway_owners(args))
        pending.append((args.capability, body, ctx['capability_new'], (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), gateway_owners(args)))
    for filename, before, after, metadata, owners in pending:
        backup = filename.with_name(f'{filename.name}.pre-upgrade-{args.release}-{stamp}')
        write_new(backup, before, *metadata, owners=owners)
        ctx['rollback'].append((filename, backup, hashlib.sha256(before).hexdigest(), owners))
        write_new(filename, after, *metadata, replace=True, owners=owners)
        say(f'  rewrote {filename} (backup {backup.name})')


class Systemd:
    def __init__(self, service, simulate):
        self.service, self.simulate, self.calls = service, simulate, []

    def ctl(self, *arguments):
        self.calls.append(' '.join(arguments))
        if not self.simulate:
            run(['systemctl', *arguments])

    def active(self):
        return self.simulate or run(['systemctl', 'is-active', self.service], check=False).stdout.strip() == 'active'


def db_row(args):
    query = ("select extract(epoch from now()), controller_status, extract(epoch from controller_seen_at) "
             f"from fleet_hosts where host_id='{args.host_id}'")
    command = f'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|" -c "{query}"'
    output = run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', args.postgres_container,
                  'sh', '-c', command]).stdout.strip()
    now, status, seen = output.split('|')
    return float(now), status, float(seen) if seen else 0.0


def socket_ok(path, gid, mode, after_ns):
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode \
        and info.st_ctime_ns >= after_ns


def effects_snapshot(args):
    return {str(item): staged_sha256(item) for item in args.state_root.rglob('effects.json')} if args.state_root.is_dir() else {}


def restart_and_verify(args, ctx, systemd):
    environment = dict(line.split('=', 1) for line in safe_read(args.controller / 'controller.env', private=True)[0].decode().splitlines()
                       if '=' in line and not line.startswith('#'))
    api_gid = int(environment.get('CAUCE_FLEET_API_GROUP_GID', '1000').strip().strip('"\''))
    systemd.ctl('daemon-reload')
    ctx['restarted'] = True
    started_ns = time.time_ns() - 1_000_000_000
    systemd.ctl('restart', args.service)
    if args.inject_failure == 'after-restart':
        raise Abort('injected failure after the restart')
    if not wait_until(systemd.active, 30):
        raise Abort('the service is not active after the restart')
    time.sleep(3)
    if not systemd.active():
        raise Abort('the service stopped being active (restart loop)')
    if systemd.simulate:
        say('  [simulation] sockets and database heartbeat are skipped')
        return
    sockets = (('auth/server.sock', api_gid, 0o660), ('authority/server.sock', 0, 0o600))
    if not wait_until(lambda: all(socket_ok(args.runtime_directory / name, gid, mode, started_ns) for name, gid, mode in sockets), 30):
        raise Abort('auth/authority sockets are missing, stale or have the wrong owner or mode')
    baseline, state = db_row(args)[0], {}

    def refreshed():
        state.update(zip(('now', 'status', 'seen'), db_row(args), strict=True))
        return state['seen'] > baseline and state['status'] == 'reachable'

    if not wait_until(refreshed, 45, 2.0):
        raise Abort(f"fleet_hosts.controller_status did not refresh within 45 s (status={state.get('status')})")
    say(f"  controller active, sockets ready, controller_status={state['status']} refreshed after the restart")


def referenced(root):
    identities = run(['docker', 'ps', '-aq', '--no-trunc']).stdout.split()
    rows = json.loads(run(['docker', 'inspect', *identities]).stdout) if identities else []
    return any(str(mount.get('Source', '')).startswith(str(root) + '/') for row in rows for mount in row.get('Mounts') or [])


def rollback(args, ctx, systemd, failure):
    say(f'ROLLBACK: {failure}')
    errors = []
    if ctx.get('restarted'):
        try:
            systemd.ctl('stop', args.service)
        except Abort as error:
            errors.append(f'controller stop: {error}')
    if not restore_configs(ctx):
        say('ROLLBACK INCOMPLETE: a configuration backup was not restored; tools root, written configuration and journal '
            'are preserved and the controller is left stopped')
        return False
    if ctx.get('restarted'):
        try:
            rebind_containers(args, ctx, args.controller / 'executor.server.v1.json', ctx['old_root'], include_running=True)
        except Abort as error:
            errors.append(f"containers may still mount {ctx['new_root']} ({error}); repeat: {ctx['python']} -B "
                          f"{ctx['new_root'] / REBIND} --policy {args.controller / 'executor.server.v1.json'} "
                          f"--release-root {ctx['old_root']} --include-running")
    if ctx.get('tools_created'):
        try:
            if errors or (not args.simulate_apply and referenced(ctx['new_root'])):
                errors.append(f"tools root kept because containers may still mount it: {ctx['new_root']}")
            else:
                shutil.rmtree(ctx['new_root'])
                say(f"  removed the tools root created by this run: {ctx['new_root']}")
        except (Abort, OSError) as error:
            errors.append(f'tools root removal: {error}')
    if ctx.get('restarted'):
        try:
            systemd.ctl('daemon-reload')
            systemd.ctl('start', args.service)
            if not wait_until(systemd.active, 30):
                errors.append('the previous controller did not become active')
        except Abort as error:
            errors.append(f'controller start: {error}')
    if errors:
        say('ROLLBACK INCOMPLETE: ' + ' | '.join(errors))
    return not errors


def upgrade(args, work):
    ctx = {'rollback': [], 'log': [], 'tools_created': False}
    systemd = Systemd(args.service, args.simulate_apply)
    applying = args.apply or args.simulate_apply
    ctx['old_root'] = current_root(args)
    ctx['new_root'] = args.tools_base / args.release
    controller = json.loads(safe_read(args.controller / 'controller.v1.json', private=True)[0])
    ctx['python'] = controller['hosts'][0]['command']['python']
    mode = 'APPLY' if args.apply else 'SIMULATED APPLY in overlay' if args.simulate_apply else 'preflight in overlay'
    say(f"Current release {ctx['old_root'].name} -> target {args.release} ({mode})")
    effects_before = effects_snapshot(args)
    if applying and not systemd.active():
        raise Abort('the controller is not active before starting; fix that first')
    say('[1/5] runtime image')
    image_id = verify_image(args)
    try:
        say('[2/5] tools root')
        new_root = install_tools(args, ctx, image_id, work)
        say('[3/5] configuration rewrite')
        plan_configs(args, ctx, new_root)
        validate_candidates(args, ctx, new_root, work)
        if all(before == after for before, after, _ in ctx['changes'].values()) and not ctx['capability_changed']:
            say('  configuration already targets the release: nothing changes, no restart')
            if applying:
                say('[5/5] fleet container migration')
                ctx['rebind'] = rebind_containers(args, ctx, args.controller / 'executor.server.v1.json', new_root)
            ctx['noop'] = True
            return ctx
        write_configs(args, ctx, datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ'))
        verify_pins(new_root, [json.loads(safe_read(args.controller / name, private=True)[0]) for name in CONFIGS])
        if json.loads(executor_capabilities(ctx, new_root, args.controller / 'executor.server.v1.json')).get('available') is not True:
            raise Abort('capabilities over the written configuration: available != true')
        if args.inject_failure == 'after-write':
            raise Abort('injected failure after rewriting the configuration')
        if not applying:
            say('[4/5] [5/5] skipped in preflight (no systemctl, no database, no container change)')
            return ctx
        say('[4/5] restart and verification')
        restart_and_verify(args, ctx, systemd)
        say('[5/5] fleet container migration')
        ctx['rebind'] = rebind_containers(args, ctx, args.controller / 'executor.server.v1.json', new_root)
        if args.inject_failure == 'after-rebind':
            raise Abort('injected failure after the container migration')
        missing = sorted(set(effects_before) - set(effects_snapshot(args)))
        if missing:
            raise Abort('effects.json disappeared: ' + ', '.join(missing))
        if args.simulate_apply:
            if args.inject_failure == 'after-simulation':
                raise Abort('injected failure at the end of the simulation')
            say('\nSIMULATED APPLY completed without errors (overlay changes are discarded)')
            ctx['simulated'] = True
            return ctx
        ctx['ok'] = True
        return ctx
    except BaseException as error:
        if not applying:
            raise
        ctx['rollback_ok'] = rollback(args, ctx, systemd, str(error))
        raise Abort(f'upgrade reverted: {error}') from None


def report(ctx):
    counts = {}
    for name, kind in ctx.get('log', []):
        counts.setdefault(name, {}).setdefault(kind, 0)
        counts[name][kind] += 1
    say(f"\nRewritten references ({len(ctx.get('log', []))}):")
    for name, kinds in counts.items():
        say(f"  {name}: {', '.join(f'{kind}={count}' for kind, count in sorted(kinds.items()))}")
    if ctx.get('changes'):
        say('Files with new content: ' + (', '.join(item.name for item, (before, after, _) in ctx['changes'].items() if before != after) or 'none'))


def mount_overlays(args, work):
    for number, target in enumerate((args.tools_base, args.fleet_config, args.unit.parent)):
        upper, scratch = work / 'overlay' / str(number) / 'upper', work / 'overlay' / str(number) / 'work'
        upper.mkdir(parents=True)
        scratch.mkdir()
        run(['mount', '-t', 'overlay', 'overlay', '-o', f'lowerdir={target},upperdir={upper},workdir={scratch}', str(target)])


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description='Upgrade the Cauce V3.5 fleet controller; preflight in a private mount namespace by default')
    parser.add_argument('--release', required=True)
    parser.add_argument('--runtime-image-from', required=True, type=pathlib.Path)
    parser.add_argument('--runtime-image-variable', default='CAUCE_RUNTIME_IMAGE')
    parser.add_argument('--ops-source', required=True, type=pathlib.Path, help='export of the release containing ops/ (.release-sha or .git)')
    parser.add_argument('--adapter-bundle', required=True, type=pathlib.Path, help='directory produced by build-adapter-release.sh')
    parser.add_argument('--expected-adapter-digest', help='sha256:... printed by build-adapter-release.sh')
    parser.add_argument('--tools-base', type=pathlib.Path, default=pathlib.Path('/usr/local/lib/cauce-v35'))
    parser.add_argument('--fleet-config', type=pathlib.Path, default=pathlib.Path('/etc/cauce-v3/fleet-v35'))
    parser.add_argument('--unit', type=pathlib.Path, default=pathlib.Path('/etc/systemd/system/cauce-fleet-v35-controller.service'))
    parser.add_argument('--state-root', type=pathlib.Path, default=pathlib.Path('/var/lib/cauce-fleet-v35'))
    parser.add_argument('--runtime-directory', type=pathlib.Path, default=pathlib.Path('/run/cauce-fleet-v35'))
    parser.add_argument('--work-root', type=pathlib.Path, default=pathlib.Path('/var/tmp/cauce-v35-private-deployment-plan/upgrade-kit'))
    parser.add_argument('--postgres-container', default='cauce-v3-prod-postgres-1')
    parser.add_argument('--host-id', default='server')
    parser.add_argument('--gateway-uid', type=int, default=1000, help='owner of the gateway fleet config (it reads private files as this uid)')
    parser.add_argument('--accept-capability-change', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--keep-work', action='store_true')
    parser.add_argument('--rehearse', action='store_true', help='preflight only: accept a release without a real image or commit')
    parser.add_argument('--simulate-apply', action='store_true', help='apply flow inside the overlay with simulated systemctl, database and containers')
    parser.add_argument('--inject-failure', choices=('after-write', 'after-restart', 'after-rebind', 'after-simulation'))
    parser.add_argument('--_namespace', dest='in_namespace', type=pathlib.Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not RELEASE_RE.fullmatch(args.release):
        parser.error('--release must be a full lowercase 40-hex SHA')
    if re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', args.host_id) is None:
        parser.error('--host-id is not a fleet host identifier')
    if args.apply and (args.rehearse or args.simulate_apply or args.inject_failure):
        parser.error('--apply cannot be combined with rehearsal or simulation options')
    if args.inject_failure and not args.simulate_apply:
        parser.error('--inject-failure requires --simulate-apply')
    for name in ('runtime_image_from', 'ops_source', 'adapter_bundle', 'tools_base', 'fleet_config', 'unit', 'state_root',
                 'runtime_directory', 'work_root'):
        value = getattr(args, name)
        if not value.is_absolute() or '..' in value.parts:
            parser.error(f"--{name.replace('_', '-')} must be an absolute path without ..")
        setattr(args, name, pathlib.Path(os.path.normpath(value)))
    args.controller, args.capability, args.service = args.fleet_config / 'controller', args.fleet_config / 'gateway/capability.v1.json', args.unit.name
    return args


def main(argv=None):
    args = parse_arguments(argv)
    require_root()
    os.umask(0o077)
    os.environ.update(CLEAN_ENV)
    if not args.in_namespace:
        os.close(directory_fd(args.work_root, private=True))
        lock = os.open(args.work_root / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Abort('another run of the upgrade kit is in progress') from None
        work = pathlib.Path(tempfile.mkdtemp(prefix=f'work-{args.release[:8]}-', dir=args.work_root))
        if not args.apply:
            child = ['unshare', '--mount', '--propagation', 'private', '--', sys.executable, '-B', str(pathlib.Path(__file__).resolve()),
                     *(argv if argv is not None else sys.argv[1:]), '--_namespace', str(work)]
            try:
                return subprocess.run(child, check=False).returncode
            finally:
                if not args.keep_work:
                    shutil.rmtree(work, ignore_errors=True)
    else:
        work = args.in_namespace
        mount_overlays(args, work)
    try:
        ctx = upgrade(args, work)
        report(ctx)
        outcome = 'apply OK' if ctx.get('ok') else 'simulated apply OK' if ctx.get('simulated') else \
            'no changes (already on the release)' if ctx.get('noop') else 'preflight OK; nothing was written outside the kit'
        say('\nRESULT: ' + outcome)
        return 0
    except Abort as error:
        say(f'\nRESULT: FAILED: {error}')
        return 2
    finally:
        if not args.in_namespace and not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Abort as failure:
        print(f'FAILED: {failure}', file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as failure:
        print(f'UNEXPECTED FAILURE ({type(failure).__name__}); inspect the state and the *.pre-upgrade-* backups', file=sys.stderr)
        sys.exit(3)
