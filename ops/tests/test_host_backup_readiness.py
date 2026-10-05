from __future__ import annotations

# cauce:requiere docker
import contextlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid
from builtins import BaseExceptionGroup
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'ops/scripts/host-backup.sh'


def command(arguments, *, check=True, timeout=15):
    return subprocess.run(arguments, capture_output=True, text=True, check=check, timeout=timeout)


def readiness(container, directory):
    source = SCRIPT.read_text()
    start = source.index('      attempt=0\n')
    end = source.index('      restored_tables=""', start)
    body = source[start:end] + '\n[ "$attempt" -lt 60 ]\n'
    stderr = directory / 'readiness.err'
    environment = dict(os.environ, restore_container=container, tmperr=str(stderr))
    return subprocess.Popen(['sh', '-c', body], env=environment, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)


def eventually(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError('Owned PostgreSQL phase did not become observable')


def drain_readiness(process):
    failures = []
    if process is None:
        return failures, True
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as error:
            failures.append(error)
    try:
        process.communicate(timeout=5)
    except Exception as error:
        failures.append(error)
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except Exception as kill_error:
                failures.append(kill_error)
            try:
                process.communicate(timeout=5)
            except Exception as reap_error:
                failures.append(reap_error)
    reaped = process.poll() is not None
    if not reaped:
        failures.append(RuntimeError('readiness process exit was not confirmed'))
    return failures, reaped


def raise_cleanup(primary, failures):
    if failures:
        errors = ([primary] if primary is not None else []) + failures
        raise BaseExceptionGroup('readiness fixture cleanup failed', errors) from primary
    if primary is not None:
        raise primary.with_traceback(primary.__traceback__)


@contextlib.contextmanager
def postgres():
    owner = uuid.uuid4().hex
    name = 'cauce-backup-readiness-' + owner
    directory = Path(tempfile.mkdtemp(prefix='cauce-backup-readiness-'))
    primary = None
    process = None
    try:
        init = directory / 'init'
        init.mkdir(mode=0o755)
        init.chmod(0o755)
        gate = init / 'hold-init.sh'
        gate.write_text('#!/bin/sh\ntouch /tmp/init-held\nwhile [ ! -e /tmp/init-release ]; do sleep 0.05; done\n')
        gate.chmod(0o644)
        command(['docker', 'run', '--detach', '--name', name, '--network', 'none',
                 '--label', 'cauce.qa.backup-readiness=' + owner, '--memory', '256m',
                 '--cpus', '1', '--pids-limit', '128',
                 '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=268435456',
                 '--mount', 'type=bind,source=' + str(init) + ',target=/docker-entrypoint-initdb.d,readonly',
                 '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=cauce_restore',
                 'postgres:16-alpine'], timeout=30)
        details = json.loads(command(['docker', 'inspect', name]).stdout)[0]
        assert details['Name'] == '/' + name and details['Config']['Labels']['cauce.qa.backup-readiness'] == owner
        assert not details['HostConfig']['PortBindings']
        assert all(mount['Type'] != 'volume' for mount in details['Mounts'])
        eventually(lambda: command(['docker', 'exec', name, 'test', '-f', '/tmp/init-held'], check=False).returncode == 0)
        process = readiness(name, directory)
        yield name, process
    except BaseException as error:
        primary = error
    finally:
        failures, reaped = drain_readiness(process)
        container_absent = False
        try:
            inspection = command(['docker', 'inspect', name], check=False)
            if inspection.returncode == 0:
                details = json.loads(inspection.stdout)[0]
                assert details['Name'] == '/' + name and details['Config']['Labels']['cauce.qa.backup-readiness'] == owner
                command(['docker', 'rm', '--force', details['Id']])
                absent = command(['docker', 'inspect', details['Id']], check=False)
                assert absent.returncode == 1 and details['Id'] in absent.stderr and 'no such object' in absent.stderr.lower()
                container_absent = True
                print(json.dumps({'ownedContainerAbsent': details['Id'], 'owner': owner, 'ports': 0, 'anonymousVolumes': 0}))
            else:
                assert inspection.returncode == 1 and name in inspection.stderr and 'no such object' in inspection.stderr.lower()
                container_absent = True
        except Exception as error:
            failures.append(error)
        if reaped and container_absent:
            try:
                shutil.rmtree(directory)
            except Exception as error:
                failures.append(error)
        else:
            failures.append(RuntimeError('preserved scratch because process or container cleanup was not confirmed'))
        raise_cleanup(primary, failures)


class HostBackupReadinessTests(unittest.TestCase):
    def test_waits_for_final_tcp_server_after_initialization(self):
        with postgres() as (name, process):
            premature = command(['docker', 'exec', name, 'pg_isready', '-U', 'postgres', '-d', 'cauce_restore'])
            self.assertEqual(premature.returncode, 0)
            with self.assertRaises(subprocess.TimeoutExpired):
                process.wait(timeout=0.5)
            command(['docker', 'exec', name, 'touch', '/tmp/init-release'])
            output, errors = process.communicate(timeout=35)
            self.assertEqual(process.returncode, 0, output + errors)
            connected = command(['docker', 'exec', name, 'psql', '-XAtq', '-h', '127.0.0.1',
                                 '-U', 'postgres', '-d', 'cauce_restore', '-c', 'SELECT current_database()'])
            self.assertEqual(connected.stdout.strip(), 'cauce_restore')

    def test_requires_expected_database_not_only_a_ready_server(self):
        with postgres() as (name, process):
            command(['docker', 'exec', name, 'touch', '/tmp/init-release'])
            process.communicate(timeout=35)
            self.assertEqual(process.returncode, 0)
            eventually(lambda: command(['docker', 'exec', name, 'psql', '-XAtq', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'], check=False).returncode == 0)
            command(['docker', 'exec', name, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
                     '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE cauce_restore'])
            self.assertEqual(command(['docker', 'exec', name, 'pg_isready', '-U', 'postgres', '-d', 'cauce_restore']).returncode, 0)
            scratch = Path(tempfile.mkdtemp(prefix='cauce-backup-missing-db-'))
            waiting = None
            primary = None
            try:
                waiting = readiness(name, scratch)
                with self.assertRaises(subprocess.TimeoutExpired):
                    waiting.wait(timeout=0.5)
                command(['docker', 'exec', name, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
                         '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE cauce_restore'])
                output, errors = waiting.communicate(timeout=10)
                self.assertEqual(waiting.returncode, 0, output + errors)
            except BaseException as error:
                primary = error
            finally:
                failures, reaped = drain_readiness(waiting)
                if reaped:
                    try:
                        shutil.rmtree(scratch)
                    except Exception as error:
                        failures.append(error)
                else:
                    failures.append(RuntimeError('preserved scratch because process or container cleanup was not confirmed'))
                raise_cleanup(primary, failures)



if __name__ == '__main__':
    unittest.main()
