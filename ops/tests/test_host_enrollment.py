from __future__ import annotations

import base64
import contextlib
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from host_channel_client import (
    HostChannel,
    HostFailure,
    ensure_key,
    gateway_url,
    post_json,
    private_directory,
    save_private,
    sign,
    stable_json,
)
from host_enrollment import enroll


class HostEnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.invitation = {'enrollment_id': str(uuid.uuid4()), 'company_id': 'company-a',
            'host_id': 'local-a', 'nonce': 'a' * 64, 'invitation_token': 'b' * 64, 'state': 'pending'}

    @contextlib.contextmanager
    def server(self, redirect=False):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, request))
                if redirect:
                    self.send_response(307)
                    self.send_header('Location', 'http://127.0.0.1:9/secret')
                    self.end_headers()
                    return
                receipt = {'enrollment_id': self.path.split('/')[-2], 'company_id': 'company-a',
                    'host_id': 'local-a', 'state': 'enrolled', 'executor_ready': False,
                    'key_fingerprint': hashlib.sha256(base64.b64decode(request['public_key'])).hexdigest()}
                encoded = stable_json(receipt)
                self.send_response(200)
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, _format, *_args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield 'http://127.0.0.1:' + str(server.server_port), requests
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_fresh_private_ed25519_key_and_stable_cross_language_encoding(self):
        key = ensure_key(self.root)
        self.assertEqual(len(key), 44)
        self.assertEqual(ensure_key(self.root), key)
        self.assertEqual((self.root / 'private.pem').stat().st_mode & 0o777, 0o600)
        message = stable_json({'z': 'á', 'a': {'b': 1, 'a': True}})
        self.assertEqual(message, b'{"a":{"a":true,"b":1},"z":"\xc3\xa1"}')
        signature = base64.b64decode(sign(self.root, message))
        (self.root / 'message').write_bytes(message)
        (self.root / 'signature').write_bytes(signature)
        (self.root / 'public.der').write_bytes(key)
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-keyform', 'DER',
            '-inkey', str(self.root / 'public.der'), '-in', str(self.root / 'message'),
            '-sigfile', str(self.root / 'signature')], capture_output=True, check=False)
        self.assertEqual(result.returncode, 0)

    def test_enrollment_receipt_retains_identity_without_invitation_and_retries_once(self):
        with self.server() as (gateway, requests):
            result = enroll(gateway, self.invitation, self.root)
            second = enroll(gateway, self.invitation, self.root)
            self.assertEqual(second['key_fingerprint'], result['key_fingerprint'])
            self.assertEqual(len(requests), 1)
            directory = self.root / 'company-a/local-a'
            saved = (directory / 'identity.json').read_text()
            self.assertNotIn(self.invitation['invitation_token'], saved)
            self.assertFalse(result['executor_ready'])
            channel = HostChannel(directory)
            first = channel.packet('POST', '/v3/fleet/hosts/local-a/heartbeat', {'status': 'reachable'})
            second = channel.packet('POST', '/v3/fleet/hosts/local-a/heartbeat', {'status': 'reachable'})
            self.assertNotEqual(first['nonce'], second['nonce'])
            self.assertEqual(first['company_id'], 'company-a')
            with self.assertRaises(HostFailure):
                channel.request('POST', '/v3/fleet/hosts/foreign/heartbeat', {})

    def test_invitation_anchors_the_setup_signer_before_the_first_package(self):
        anchor = 'c' * 64
        with self.server() as (gateway, requests):
            enroll(gateway, {**self.invitation, 'setup_signer_fingerprint': anchor}, self.root)
            directory = self.root / 'company-a/local-a'
            self.assertEqual(json.loads((directory / 'setup-signer.json').read_text()), {'fingerprint': anchor})
            self.assertEqual((directory / 'setup-signer.json').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('setup_signer_fingerprint', json.loads((directory / 'identity.json').read_text()))
            enroll(gateway, {**self.invitation, 'setup_signer_fingerprint': 'd' * 64}, self.root)
            self.assertEqual(json.loads((directory / 'setup-signer.json').read_text()), {'fingerprint': anchor})
            self.assertEqual(len(requests), 1)

    def test_other_company_identity_in_the_same_state_root_is_rejected_before_a_new_key(self):
        other = self.root / 'company-b' / 'local-b'
        other.mkdir(parents=True)
        (other / 'identity.json').write_text('{}')
        with self.assertRaisesRegex(HostFailure, 'one system user per company'):
            enroll('http://127.0.0.1:9', self.invitation, self.root)
        self.assertFalse((self.root / 'company-a').exists())

    def test_malformed_signer_anchor_rejects_the_invitation(self):
        cli = pathlib.Path(__file__).resolve().parents[1] / 'cli/host_enrollment.py'
        for anchor in ('A' * 64, 'c' * 63, 7):
            invitation = json.dumps({**self.invitation, 'setup_signer_fingerprint': anchor})
            result = subprocess.run([sys.executable, str(cli), 'enroll', '--gateway', 'http://127.0.0.1:9', '--invitation-stdin',
                '--state-root', str(self.root)], input=invitation.encode(), capture_output=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertFalse((self.root / 'company-a').exists())

    def test_response_failure_retains_pending_key_for_recovery(self):
        with self.server(redirect=True) as (gateway, requests):
            with self.assertRaises(HostFailure):
                enroll(gateway, self.invitation, self.root)
            directory = self.root / 'company-a/local-a'
            first_key = ensure_key(directory)
            self.assertEqual(json.loads((directory / 'identity.json').read_text())['state'], 'pending')
            with self.assertRaises(HostFailure):
                enroll(gateway, self.invitation, self.root)
            self.assertEqual(ensure_key(directory), first_key)
            self.assertEqual(len(requests), 2)

    def test_existing_identity_cannot_be_rebound_or_key_replaced(self):
        with self.server() as (gateway, requests):
            enroll(gateway, self.invitation, self.root)
            with self.assertRaises(HostFailure):
                enroll(gateway, {**self.invitation, 'enrollment_id': str(uuid.uuid4())}, self.root)
            self.assertEqual(len(requests), 1)
            directory = self.root / 'company-a/local-a'
            (directory / 'private.pem').unlink()
            ensure_key(directory)
            with self.assertRaises(HostFailure):
                HostChannel(directory)

    def test_permissions_and_symlinks_are_rejected(self):
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o755)
        unsafe.chmod(0o755)
        with self.assertRaises(HostFailure):
            private_directory(unsafe)
        linked = self.root / 'linked'
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(HostFailure):
            private_directory(linked)
        ensure_key(self.root)
        os.chmod(self.root / 'private.pem', 0o644)
        with self.assertRaises(HostFailure):
            ensure_key(self.root)

    def test_https_no_ambient_credentials_or_external_cleartext(self):
        for gateway in ('http://example.org', 'https://u:p@example.org', 'https://example.org/path',
                'https://example.org/?token=a', 'file:///tmp/secret'):
            with self.subTest(gateway=gateway), self.assertRaises(HostFailure):
                gateway_url(gateway)
        self.assertEqual(gateway_url('https://example.org/'), 'https://example.org')
        with self.server(redirect=True) as (gateway, requests):
            with self.assertRaises(HostFailure):
                post_json(gateway, '/v3/fleet/hosts/test/heartbeat', {})
            self.assertEqual(len(requests), 1)

    def test_pending_identity_cannot_open_channel(self):
        ensure_key(self.root)
        save_private(self.root / 'identity.json', {'state': 'pending'})
        with self.assertRaises(HostFailure):
            HostChannel(self.root)

    def test_numbers_match_server_json_stringify(self):
        self.assertEqual(stable_json({'a': 1.0, 'b': 1e-7, 'c': -0.0, 'd': 1e20, 'e': 1e-6}),
            b'{"a":1,"b":1e-7,"c":0,"d":100000000000000000000,"e":0.000001}')
        with self.assertRaises(HostFailure):
            stable_json({'unsafe': 9007199254740992})
        for value in ({'a': 1.0, 'unsafe': 9007199254740993}, [1.0, 9007199254740993]):
            with self.assertRaises(HostFailure):
                stable_json(value)
        self.assertEqual(stable_json({'\uffff': 'last', '\U00010000': 'first'}),
            '{"\U00010000":"first","\uffff":"last"}'.encode())

    def test_quota_cli_arguments_cannot_execute_remote_shell_fragments(self):
        binary = self.root / '.local/bin'
        binary.mkdir(parents=True)
        ssh = binary / 'ssh'
        ssh.write_text('#!/bin/bash\nexec bash -c "${@: -1}"\n')
        ssh.chmod(0o755)
        quota = binary / 'cuotas'
        quota.write_text('#!/usr/bin/python3\nimport json,os,sys\nopen(os.environ["TEST_QUOTA_ARGUMENTS"],"w").write(json.dumps(sys.argv[1:]))\n')
        quota.chmod(0o755)
        marker = self.root / 'unexpected-effect'
        arguments = ['--model', 'gpt; touch ' + str(marker), '$(touch ' + str(marker) + ')']
        recorded = self.root / 'arguments.json'
        environment = {'PATH': str(binary) + ':/usr/bin:/bin', 'HOME': str(self.root), 'CAUCE_FLEET_RUNTIME_STATE': 'active',
            'CUOTAS_HOST': 'authorized-synthetic', 'TEST_QUOTA_ARGUMENTS': str(recorded)}
        cli = pathlib.Path(__file__).resolve().parents[1] / 'cli/cauce'
        result = subprocess.run(['bash', str(cli), 'coutas', *arguments], env=environment, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(recorded.read_text()), arguments)


if __name__ == '__main__':
    unittest.main()
