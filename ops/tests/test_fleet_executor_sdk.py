from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
import test_fleet_executor_container as containers

PROJECT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = PROJECT / 'packages/adapter-sdk/src/bin/config.ts'
PROFILE = PROJECT / 'packages/adapter-sdk/src/sdk/bootstrap-profile.ts'


def assert_sdk(self, environment: dict):
    script = 'import {loadCliRuntimeConfig} from ' + json.dumps(CONFIG.as_uri()) + ';' \
        'const c=await loadCliRuntimeConfig("codex",[]);console.log(JSON.stringify(c));'
    result = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module', '-e', script],
        env=environment, cwd=PROJECT, capture_output=True, text=True, timeout=10)
    self.assertEqual(result.returncode, 0, result.stderr)
    config = json.loads(result.stdout)
    self.assertEqual(config['tenant'], self.agent['tenant_id'])
    self.assertEqual(config['alias'], self.agent['alias'])
    self.assertEqual(config['room'], self.agent['primary_room_id'])
    self.assertEqual(config['relayUrl'], 'wss://gateway.fixture.invalid/v3/ws')
    self.assertEqual(config['instanceId'], str(uuid.uuid5(uuid.NAMESPACE_URL,
        '\0'.join((self.context['operation_id'], self.agent['tenant_id'], self.agent['runtime_key'])))))
    self.assertTrue(config['mutualTls']['keyFile'].endswith('/bootstrap/agent.key'))
    self.assertFalse(config['developmentIdentity'])
    self.assertNotIn('CAUCE_CONFIG_FILE', environment)
    self.assertNotIn('CAUCE_TLS_CERT_FILE', environment)
    self.assertNotIn('CAUCE_TLS_KEY_FILE', environment)
    self.assertNotIn('CAUCE_TLS_CA_FILE', environment)
    self.assertEqual(environment.get('HOME'), self.agent['home_directory'])
    directory = self.root / 'sdk-profile-fixture'
    directory.mkdir(mode=0o700)
    script = ('import {createHash} from "node:crypto";'
        'import {bloqueDePerfil,emptyAgentProfile,ficherosDelArnes,revisionDelPerfil} from "@cauce/protocol";'
        'import {measureBootstrapProfile} from ' + json.dumps(PROFILE.as_uri()) + ';'
        'const environment={...process.env,CODEX_HOME:' + json.dumps(str(directory)) + '};'
        'const profile={operation_id:' + json.dumps(self.context['operation_id']) + ',phase:"bootstrap",'
        'tenant_id:' + json.dumps(self.agent['tenant_id']) + ',alias:' + json.dumps(self.agent['alias']) + ',runtime_key:"physical-one",'
        'harness_id:"codex",model_id:"fixture-model",account_id:"fixture-account",profile_revision:1,documents:[],contexto:{'
        'perfil:{...emptyAgentProfile(' + json.dumps(self.agent['tenant_id']) + ',' + json.dumps(self.agent['alias']) + '),purpose:"SDK fixture purpose"},'
        'hechos:{permisos:{ruta:false,lectura:false,control:false,notificacion:false},cuotas:[],destinos:[],'
        'arnes:{harness:"codex",home:' + json.dumps(self.agent['home_directory']) + ',capacidades:[]}}}};'
        'profile.documents=ficherosDelArnes("codex",profile.contexto,new Map(),{revision:1})'
        '.filter(file=>file.politica==="bloque-gestionado").map(file=>({name:file.nombre,'
        'sha256:createHash("sha256").update(bloqueDePerfil(file.texto)??"").digest("hex"),native_revision:revisionDelPerfil(file.texto)??null}));'
        'measureBootstrapProfile(profile,{apply:true,expected:profile.documents,environment});'
        'const proof=measureBootstrapProfile(profile,{apply:false,expected:profile.documents,environment});'
        'let rejected=false;try{measureBootstrapProfile(profile,{apply:false,expected:profile.documents,environment:{...environment,HOME:"/changed-home"}})}catch{rejected=true}'
        'console.log(JSON.stringify({documents:proof.length,changed_home_rejected:rejected}));')
    result = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module', '-e', script],
        env=environment, cwd=PROJECT, capture_output=True, text=True, timeout=10)
    self.assertEqual(result.returncode, 0, result.stderr)
    proof = json.loads(result.stdout)
    self.assertGreater(proof['documents'], 0)
    self.assertTrue(proof['changed_home_rejected'])
    self.assertIn('SDK fixture purpose', (directory / 'AGENTS.md').read_text())


class NativeSdkRuntimeEnvironmentTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    tearDown = fixtures.PhysicalExecutorTest.tearDown
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    run_step = fixtures.PhysicalExecutorTest.run_step

    def test_real_sdk_parser_accepts_observed_native_environment_without_host_overrides(self):
        self.configure_signer()
        for step in ('artifacts', 'credentials'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--step', 'runtime'],
            input=json.dumps(self.context), capture_output=True, text=True, timeout=20,
            env={**os.environ, 'CAUCE_CONFIG_FILE': '/private/unapproved-fixture.json',
                'CAUCE_TLS_KEY_FILE': '/private/unapproved-key-fixture'})
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads((self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json').read_bytes())
        environment = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode()
            for item in pathlib.Path('/proc/' + str(metadata['pid']) + '/environ').read_bytes().split(b'\0') if b'=' in item}
        assert_sdk(self, environment)
        replay = self.run_step('runtime')
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(json.loads((self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json').read_bytes())['pid'], metadata['pid'])

    def test_missing_approved_sdk_transport_never_starts_runtime(self):
        self.configure_signer()
        self.policy.pop('transport')
        self.save_policy()
        self.assertEqual(self.run_step('artifacts').returncode, 0)
        self.assertEqual(self.run_step('credentials').returncode, 0)
        self.assertNotEqual(self.run_step('runtime').returncode, 0)
        self.assertFalse((self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json').exists())


class ContainerSdkRuntimeEnvironmentTest(unittest.TestCase):
    setUp = containers.DisposableContainerExecutorTest.setUp
    tearDown = containers.DisposableContainerExecutorTest.tearDown
    save_policy = containers.DisposableContainerExecutorTest.save_policy
    configure_signer = containers.DisposableContainerExecutorTest.configure_signer
    configure_container = containers.DisposableContainerExecutorTest.configure_container
    run_step = containers.DisposableContainerExecutorTest.run_step

    @classmethod
    def setUpClass(cls):
        containers.DisposableContainerExecutorTest.setUpClass.__func__(cls)

    def test_real_sdk_parser_accepts_environment_measured_inside_owned_container(self):
        self.configure_container()
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads(subprocess.run(['docker', 'exec', self.container, 'cat',
            '/run/cauce-fleet/physical-one/cauce-v3-adapter.json'], capture_output=True, text=True, check=True).stdout)
        raw = subprocess.run(['docker', 'exec', self.container, 'cat', '/proc/' + str(metadata['pid']) + '/environ'],
            capture_output=True, check=True).stdout
        environment = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode() for item in raw.split(b'\0') if b'=' in item}
        assert_sdk(self, environment)
        self.assertEqual(metadata['runtimeUid'], 65534)


if __name__ == '__main__':
    unittest.main()
