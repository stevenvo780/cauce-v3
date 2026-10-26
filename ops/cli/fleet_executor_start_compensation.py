"""Cancelling a start of a baseline (relocated) identity.

A baseline identity keeps credentials no start issues: its legacy base authority records and the normal credentials an
earlier operation installed, which the next start reuses. The generic compensation revokes every Cauce credential of
the runtime; for a baseline identity that needs an exact legacy inventory (it fails forever without one) and would
destroy what another operation issued. A start issues at most its own bootstrap credential before admission, so its
compensation leaves the runtime stopped, revokes exactly what the central authority recorded as issued under this
operation, observes the gateway rejecting it, and removes only the local files of that issuance."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import ssl
import stat

from fleet_executor_policy import SafeFailure, open_absolute_directory, open_regular_at

STEPS = frozenset({'runtime', 'authenticate', 'profile', 'verify', 'admission'})
PHASES = ('bootstrap', 'normal')
REQUEST = '.authority-request.json'


def _assert_start_journal(executor) -> None:
    journal = executor.journal
    if any(step not in STEPS for step in journal.get('attempted', [])) or 'admission' in journal \
            or any(name in journal for name in ('revocation_complete', 'compensation_credential_effects', 'runtime_launch_attempted')) \
            or any(journal.get(name) for name in ('central_revocations', 'compensated', 'revoked', 'legacy_authority_absence')):
        raise SafeFailure('baseline start compensation found effects a start never makes before admission; inspect its journal')
    pending = journal.get('admission_pending_generation')
    if pending is not None and (executor.state / 'applied-fleet.json').exists():
        from fleet_runtime_materialization import load_applied_fleet
        if load_applied_fleet(executor.state)['generation'] == pending:
            raise SafeFailure('baseline start admission was already published; inspect its journal')


def _paths(policy: dict, key: str, phase: str) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    pair = pathlib.Path(policy['roots']['pki']) / phase / key
    return pair, pair / ('agent-' + key + '.crt'), pathlib.Path(policy['roots']['tokens']) / phase / (key + '.token')


def _read_private(parent: pathlib.Path, name: str) -> bytes | None:
    try:
        directory = open_absolute_directory(parent)
    except FileNotFoundError:
        return None
    try:
        try:
            descriptor = open_regular_at(directory, name, os.O_RDONLY)
        except FileNotFoundError:
            return None
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                    or details.st_size > 65536:
                raise SafeFailure('local credential file has an unsafe owner or link')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                return stream.read(65537)
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


def local_issuance(executor, row: dict, phase: str) -> dict | None:
    """The local files of this operation's own issuance attempt for a phase, or None when that phase holds none (absent,
    or another operation's credential, which stays). The CSR request names the operation that issued it."""
    pair, certificate, token = _paths(executor.policy, row['runtime_key'], phase)
    request = _read_private(pair, REQUEST)
    if request is None:
        return None
    try:
        origin = json.loads(request).get('scope', {}).get('operation_id')
    except (ValueError, AttributeError):
        raise SafeFailure('local credential issuance request is unreadable') from None
    if origin != executor.context['operation_id']:
        return None
    found = {'pair': pair, 'token_path': token}
    pem = _read_private(pair, certificate.name)
    if pem is not None:
        found['certificate_sha256'] = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest()
        found['certificate_path'], found['key_path'] = certificate, pair / ('agent-' + row['runtime_key'] + '.key')
    raw = _read_private(token.parent, token.name)
    if raw is not None:
        found['token_sha256'] = hashlib.sha256(raw.strip()).hexdigest()
        found['token'] = raw.strip()
    return found


def observe_rejected(executor, phase: str, local: dict) -> None:
    transport = executor.policy.get('transport')
    if not isinstance(transport, dict) or not isinstance(transport.get('gateway_url'), str) \
            or not isinstance(transport.get('ca_certificate'), str):
        raise SafeFailure('revocation observation requires the approved gateway transport')
    if 'certificate_path' not in local:
        return
    import fleet_provider_revoke as probe
    try:
        context = probe.pinned_context(transport['ca_certificate'])
        context.load_cert_chain(str(local['certificate_path']), str(local['key_path']))
        # TLS refuses an expired client certificate before the gateway answers; the authority already proved it absent.
        if probe.expired(str(local['certificate_path'])):
            return
        if not probe.rejected(transport['gateway_url'], context, phase):
            raise SafeFailure('revoked Cauce certificate was not rejected')
        if 'token' in local and not probe.rejected(transport['gateway_url'], context, phase, local['token'].decode('ascii')):
            raise SafeFailure('revoked Cauce bearer was not rejected')
    except SafeFailure:
        raise
    except (OSError, ValueError, ssl.SSLError):
        raise SafeFailure('revoked Cauce credential rejection was not observed') from None


def remove_local(executor, row: dict, local: dict) -> None:
    from fleet_executor_retirement import remove_tree
    token = local['token_path']
    if token.exists() or token.is_symlink():
        parent = open_absolute_directory(token.parent)
        try:
            descriptor = open_regular_at(parent, token.name, os.O_RDONLY)
            try:
                details, actual = os.fstat(descriptor), os.stat(token.name, dir_fd=parent, follow_symlinks=False)
                if details.st_nlink != 1 or details.st_uid != os.geteuid() \
                        or (details.st_dev, details.st_ino) != (actual.st_dev, actual.st_ino):
                    raise SafeFailure('credential file changed before removal')
                os.unlink(token.name, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(descriptor)
        finally:
            os.close(parent)
    # The request file goes last with its directory: a replay still recognizes a partly removed issuance as its own.
    # A recursive removal visits entries in no fixed order, so every other file is unlinked first.
    try:
        pair = open_absolute_directory(local['pair'])
    except FileNotFoundError:
        pair = None
    if pair is not None:
        try:
            for name in sorted(entry for entry in os.listdir(pair) if entry != REQUEST):
                details = os.stat(name, dir_fd=pair, follow_symlinks=False)
                if stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid():
                    os.unlink(name, dir_fd=pair)
            os.fsync(pair)
        finally:
            os.close(pair)
    remove_tree(local['pair'].parent, local['pair'].name)


def compensate_baseline_start(executor, rows: list[dict]) -> dict:
    from fleet_executor_authority import revoke_issued
    from fleet_executor_retirement import remove_runtime_credentials
    _assert_start_journal(executor)
    provenance = executor.journal.get('credential_provenance', {})
    records = executor.journal.setdefault('start_compensation', {})
    for row in {row['runtime_key']: row for row in rows}.values():
        revoked = revoke_issued(executor.policy, executor.context, row)
        for phase, origin in provenance.items() if isinstance(provenance, dict) else ():
            if not isinstance(origin, dict):
                raise SafeFailure('credential provenance journal is invalid')
            mine = {'phase': phase, 'certificate_sha256': origin.get('certificate_sha256'), 'token_sha256': origin.get('token_sha256')}
            if origin.get('source') == 'issued' and origin.get('origin_operation_id') == executor.context['operation_id'] \
                    and mine not in revoked:
                raise SafeFailure('the central authority did not revoke a credential this operation issued')
            if origin.get('source') != 'issued' and any(entry['certificate_sha256'] == mine['certificate_sha256'] for entry in revoked):
                raise SafeFailure('the central authority revoked a credential this operation reused')
        for phase in PHASES:
            local = local_issuance(executor, row, phase)
            if local is None:
                continue
            matches = [entry for entry in revoked if entry['phase'] == phase]
            if ('certificate_sha256' in local or 'token_sha256' in local) and (len(matches) != 1
                    or local.get('certificate_sha256', matches[0]['certificate_sha256']) != matches[0]['certificate_sha256']
                    or local.get('token_sha256', matches[0]['token_sha256']) != matches[0]['token_sha256']):
                raise SafeFailure('local credential of this operation differs from its revoked issuance')
            if matches:
                observe_rejected(executor, phase, local)
            remove_local(executor, row, local)
        remove_runtime_credentials(executor.policy, row)
        records[row['runtime_key']] = {'revoked': revoked, 'complete': True}
        executor.save()
    return {'stopped_verified': True, 'revocation_verified': True}
