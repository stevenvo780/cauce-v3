from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = ROOT / 'ops/cli'
sys.path.insert(0, str(CLI))
import fleet_executor_hooks as hooks  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402
import fleet_provider_muse as muse  # noqa: E402
import fleet_provider_probe as probe  # noqa: E402

SPEC = importlib.util.spec_from_file_location('fleet_provider_hook_timeouts', CLI / 'fleet-provider-hook.py')
hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hook)

# The values every harness but Muse ran with before Muse had its own window: they must not move.
DEFAULTS = {'roundtrip': 90, 'verify_poll': 105, 'container_exec': 132, 'executor_hook': 140, 'host_step': 150}
MUSE = {'roundtrip': 240, 'verify_poll': 250, 'container_exec': 270, 'executor_hook': 280, 'host_step': 300}


class ProofTimeoutContractTests(unittest.TestCase):
    def test_defaults_are_unchanged_and_nested(self):
        self.assertEqual(identity.default_proof_timeouts(), DEFAULTS)
        self.assertEqual(identity.validate_proof_timeouts(DEFAULTS), DEFAULTS)
        self.assertEqual(identity.ROUNDTRIP_TIMEOUT, 90)

    def test_only_muse_widens_and_only_for_steps_that_run_a_provider_turn(self):
        self.assertEqual(muse.PROOF_TIMEOUTS, MUSE)
        for step in ('authenticate', 'verify'):
            self.assertEqual(identity.proof_timeouts('fleet_provider_muse', step), MUSE)
        for step in ('profile', 'revoke', None):
            self.assertEqual(identity.proof_timeouts('fleet_provider_muse', step), DEFAULTS)
        for module in (None, 'fleet_provider_grok', 'fleet_provider_openclaw'):
            for step in ('authenticate', 'profile', 'verify', 'revoke'):
                with self.subTest(module=module, step=step):
                    self.assertEqual(identity.proof_timeouts(module, step), DEFAULTS)
        for module in ('fleet_provider_grok', 'fleet_provider_openclaw'):
            self.assertFalse(hasattr(importlib.import_module(module), 'PROOF_TIMEOUTS'), module)

    def test_muse_window_covers_the_measured_wonder_full_turn_with_room(self):
        # Measured 2026-11-03: up to 46 s at high effort and once over 60 s; the target window is ~240 s.
        self.assertGreaterEqual(MUSE['roundtrip'], 240)
        self.assertGreaterEqual(MUSE['verify_poll'], 240)
        self.assertLessEqual(MUSE['host_step'], identity.HOST_STEP_LIMIT)

    def test_validation_rejects_unnested_unbounded_or_malformed_windows(self):
        for broken in ({**MUSE, 'container_exec': 250}, {**MUSE, 'verify_poll': 270}, {**MUSE, 'executor_hook': 270},
                       {**MUSE, 'host_step': 280}, {**MUSE, 'host_step': 301, 'executor_hook': 290},
                       {**MUSE, 'roundtrip': 0}, {**MUSE, 'roundtrip': 240.0}, {**MUSE, 'roundtrip': True},
                       {key: value for key, value in MUSE.items() if key != 'verify_poll'}, {**MUSE, 'extra': 1}, None):
            with self.subTest(broken=broken), self.assertRaises(identity.ProviderProofError):
                identity.validate_proof_timeouts(broken)

    def test_a_module_with_an_unnested_window_fails_closed(self):
        with mock.patch.dict(muse.PROOF_TIMEOUTS, {'container_exec': 100}), self.assertRaises(identity.ProviderProofError):
            identity.proof_timeouts('fleet_provider_muse', 'authenticate')

    def test_typescript_mirror_keeps_the_same_muse_window(self):
        source = (ROOT / 'packages/protocol/src/provider-proof-window.ts').read_text()

        def window(name):
            match = re.search(name + r': ProviderProofWindow = Object\.freeze\(\{([^}]*)\}\)', source)
            self.assertIsNotNone(match, name)
            return {key: int(value.replace('_', '')) for key, value in re.findall(r'(\w+): ([0-9_]+)', match.group(1))}

        default, widened = window('DEFAULT_PROVIDER_PROOF_WINDOW'), window('MUSE_PROVIDER_PROOF_WINDOW')
        self.assertEqual(default, {'turnMs': 100_000, 'claimMs': 50_000, 'deadlineMs': 120_000, 'hostStepMs': 150_000})
        self.assertEqual(widened['hostStepMs'], MUSE['host_step'] * 1000)
        self.assertEqual(widened['turnMs'], MUSE['roundtrip'] * 1000)
        runner = (ROOT / 'packages/adapter-sdk/src/sdk/bootstrap-runner.ts').read_text()
        turns = {name: int(value.replace('_', '')) for name, value in re.findall(r'const (\w*VERIFY_TURN_MS) = ([0-9_]+);', runner)}
        self.assertEqual(turns, {'VERIFY_TURN_MS': default['turnMs'], 'MUSE_VERIFY_TURN_MS': widened['turnMs']})
        # The adapter turn must ack inside the claim, the claim inside the probe deadline, and the hook poll must
        # outlast the turn while ending before the probe expires.
        self.assertLess(widened['turnMs'], widened['claimMs'])
        self.assertLess(widened['claimMs'], widened['deadlineMs'])
        self.assertLess(widened['turnMs'], MUSE['verify_poll'] * 1000)
        self.assertLess(MUSE['verify_poll'] * 1000, widened['deadlineMs'])
        self.assertIn('HOST_STEP_LIMIT_MS = 300_000', source)
        self.assertEqual(identity.HOST_STEP_LIMIT, 300)


class ProofTimeoutWiringTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='proof-timeouts-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.user = pwd.getpwuid(os.getuid()).pw_name

    def packet(self, harness, step='authenticate'):
        return {'operation_id': '00000000-0000-4000-8000-000000000001', 'step': step, 'nonce': 'a' * 64,
                'account_id': 'approved', 'identity': 'subject',
                'agent': {'tenant_id': 'Steven', 'alias': 'proof', 'runtime_key': 'proof', 'harness_id': harness,
                          'runtime_mode': 'native', 'runtime_user': self.user, 'home_directory': str(self.root),
                          'state_directory': str(self.state), 'model_id': None},
                'profile_binding': {'provider': harness, 'identity': 'subject', 'runtime_user': self.user}}

    def test_nonce_round_trip_uses_the_harness_window(self):
        for harness, expected in (('muse', 240), ('grok', 90)):
            with self.subTest(harness=harness), mock.patch.object(identity, 'provider_command', return_value='/bin/true'), \
                    mock.patch.object(identity, 'command_output', return_value=b'') as output:
                identity.nonce_roundtrip(self.packet(harness), lambda prompt: ['exec', prompt], lambda _: 'CAUCE_BOOTSTRAP_' + 'a' * 64)
                self.assertEqual(output.call_args.args[2], expected)
            self.assertEqual(list(self.state.glob('.cauce-auth-prompt-*')), [])

    def container_packet(self, harness, step):
        packet = self.packet(harness, step)
        packet['agent']['runtime_mode'] = 'container'
        packet['runtime_binding'] = {'container_id': 'c' * 64, 'image_digest': 'sha256:' + 'd' * 64, 'python': '/usr/bin/python3',
                                     'generation': hashlib.sha256(('c' * 64 + '\0t').encode()).hexdigest()}
        observed = [{'Id': 'c' * 64, 'Image': 'sha256:' + 'd' * 64, 'State': {'Running': True, 'StartedAt': 't'},
                     'Config': {'Labels': {'cauce.fleet.runtime_key': 'proof', 'cauce.fleet.tenant': 'Steven',
                                           'cauce.fleet.alias': 'proof'}}}]
        return packet, json.dumps(observed).encode()

    def test_container_exec_takes_the_muse_window_only_for_its_provider_turn_steps(self):
        cases = [('muse', 'authenticate', 270), ('muse', 'verify', 270), ('muse', 'profile', 132),
                 ('grok', 'authenticate', 132), ('openclaw', 'verify', 132), ('codex', 'authenticate', 132)]
        for harness, step, expected in cases:
            packet, observed = self.container_packet(harness, step)
            done = subprocess.CompletedProcess([], 0, b'{"authenticated":true}', b'')
            with self.subTest(harness=harness, step=step), mock.patch.object(hook.subprocess, 'check_output', return_value=observed), \
                    mock.patch.object(hook.subprocess, 'run', return_value=done) as run:
                hook.container(packet)
                self.assertEqual(run.call_args.kwargs['timeout'], expected)

    def test_container_exec_timeout_names_the_muse_window(self):
        packet, observed = self.container_packet('muse', 'authenticate')
        with mock.patch.object(hook.subprocess, 'check_output', return_value=observed), \
                mock.patch.object(hook.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['docker'], 270)), \
                mock.patch('sys.stderr') as stderr, self.assertRaises(ValueError):
            hook.container(packet)
        printed = ''.join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn('fleet identity probe failed: probe_timeout after 270s', printed)

    def test_executor_hook_takes_the_muse_window_only_for_its_provider_turn_steps(self):
        executable = pathlib.Path(sys.executable).resolve()
        policy = {'executor_user': self.user, 'transport': {}, 'hooks': {
            step: {'executable': str(executable), 'sha256': 'f' * 64, 'argv': [], 'user': self.user}
            for step in ('authenticate', 'profile', 'verify')}}

        def answered(command, *, input, **_):
            sent = json.loads(input)
            receipt = {key: sent['agent'][key] for key in ('tenant_id', 'alias', 'runtime_key')}
            receipt.update(account_id=sent['account_id'], identity=sent['identity'], nonce=sent['nonce'], authenticated=False)
            return subprocess.CompletedProcess(command, 0, json.dumps(receipt).encode(), b'')

        cases = [('muse', 'authenticate', 280), ('muse', 'verify', 280), ('muse', 'profile', 140),
                 ('grok', 'authenticate', 140), ('openclaw', 'verify', 140), ('codex', 'authenticate', 140)]
        for harness, step, expected in cases:
            agent = {**self.packet(harness)['agent']}
            with self.subTest(harness=harness, step=step), mock.patch.object(hooks, 'digest', return_value='f' * 64), \
                    mock.patch.object(hooks.subprocess, 'run', side_effect=answered) as run:
                hooks.invoke_bound(policy, {'operation_id': '00000000-0000-4000-8000-000000000001'}, agent, step,
                                   'approved', 'subject', None)
                self.assertEqual(run.call_args.kwargs['timeout'], expected)

    def test_verify_poll_takes_the_muse_window_and_profile_keeps_the_default(self):
        cases = [('muse', 'verify', 250), ('muse', 'profile', 105), ('codex', 'verify', 105), ('grok', 'verify', 105)]
        for harness, step, expected in cases:
            packet = self.packet(harness, step)
            packet['transport'] = {'bootstrap_url': 'https://fixture.invalid', 'gateway_url': 'https://fixture.invalid'}
            profile = {key: packet['agent'][key] for key in ('tenant_id', 'alias', 'runtime_key', 'harness_id')}
            profile.update(operation_id=packet['operation_id'], phase='bootstrap', account_id='approved', model_id=None,
                           profile_revision=1)
            descriptor = {**profile, 'action': step, 'nonce': packet['nonce'], 'probe_id': 'fixture', 'documents': []}
            pending = {'probe': descriptor, 'state': 'pending', 'proof': None}

            class Clock:
                now = 1000.0

                def monotonic(self):
                    return self.now

                def sleep(self, seconds):
                    self.now += seconds

            def answer(*args, profile=profile, pending=pending, **_):
                return profile if args[2] == 'GET' and args[3].startswith('/v3/bootstrap/profile?') else pending

            clock = Clock()
            with self.subTest(harness=harness, step=step), mock.patch.object(probe, 'credential_context'), \
                    mock.patch.object(probe, 'request', side_effect=answer), \
                    mock.patch.object(probe, 'time', clock), self.assertRaisesRegex(probe.ProbeError, 'did not acknowledge'):
                probe.probe(packet)
            self.assertGreaterEqual(clock.now - 1000.0, expected)
            self.assertLess(clock.now - 1000.0, expected + 1)


if __name__ == '__main__':
    unittest.main()
