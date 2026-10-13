import json
import pathlib
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
DESCRIPTORS = ROOT / 'packages/adapter-sdk/descriptors'
# Providers that are not harnesses: they may appear in quota enums without a descriptor.
NON_HARNESS_PROVIDERS = {'gemini', 'minimax', 'feihoa'}
# Descriptor harnesses the gateway document catalog does not classify today.
GATEWAY_OMITTED = {'opencode', 'fake', 'fake2'}
# Descriptor harnesses the console catalog has not picked up yet; shrink as it aligns.
CONSOLE_PENDING = {'opencode', 'fake', 'fake2'}
# Harnesses whose provider exposes a measurable quota window with the credential
# the container already holds; each declares operations.quota with a reader argv.
QUOTA_READERS = {'claude', 'codex', 'grok'}
# Harnesses with no quota reader, by provider fact rather than by omission:
# openclaw proxies an upstream provider account and exposes no window of its own,
# the muse CLI has no usage command or documented quota endpoint, hermes and
# opencode declare no provider account to measure, and fake/fake2 are test
# harnesses. The executor answers quota_reader_unavailable for these and the
# console renders that closed code as an explicit no-reader state.
NO_QUOTA_READER = {'openclaw', 'muse', 'hermes', 'opencode', 'fake', 'fake2'}
# Closed vocabulary of harness_definitions.capabilities as seeded by the migrations;
# the strings are rendered into agent profile facts, so a new one is a deliberate edit here.
SEEDED_CAPABILITIES = {'messages.receive', 'ack.timeline', 'origin.relay', 'jobs.interactive', 'jobs.batch'}


def seeded_harness_definitions(paths=None):
    rows = {}
    checks = []
    migrations = (ROOT / 'packages/store/migrations').glob('*.sql') if paths is None else paths
    for path in sorted(migrations):
        for block in re.finditer(r'INSERT\s+INTO\s+harness_definitions\b.*?;', path.read_text(), re.S | re.I):
            matches = list(re.finditer(
                r"\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'(\[[^']*\])'\s*::\s*jsonb\s*\)",
                block.group(0), re.I))
            if not matches:
                checks.append((f'packages/store/migrations/{path.name}',
                               'INSERT INTO harness_definitions produced no parsed seed rows'))
            for match in matches:
                harness, display_name, capabilities = match.groups()
                if harness in rows:
                    checks.append((f'packages/store/migrations/{path.name}',
                                   f"harness '{harness}' is seeded more than once"))
                rows[harness] = (path.name, display_name, json.loads(capabilities))
    return rows, checks


def text(path):
    return (ROOT / path).read_text()


def quoted(segment):
    return set(re.findall(r"'([a-z][a-z0-9_-]*)'", segment))


def descriptors():
    return {path.stem: json.loads(path.read_text()) for path in sorted(DESCRIPTORS.glob('*.json'))}


def quota_reader_contract_checks():
    contracts = {
        'packages/store/src/agent-quota-operations-model.ts': r'\bharness_id\s+IN\s*\(([^)]*)\)',
        'ops/cli/fleet_executor_agent_quota.py': r'\bPROVIDERS\s*=\s*frozenset\s*\(\s*\{([^}]*)\}\s*\)',
        'packages/protocol/src/agent-quota.ts':
            r'\bAgentQuotaReceiptSchema\s*=\s*z\.discriminatedUnion\b.*?\bprovider:\s*z\.enum\(\[([^\]]*)\]\)',
    }
    checks = []
    for path, pattern in contracts.items():
        matches = re.findall(pattern, text(path), re.S)
        if not matches:
            checks.append((path, 'quota reader contract not found'))
        for match in matches:
            readers = quoted(match)
            if readers != QUOTA_READERS:
                checks.append((path, f'quota readers {sorted(readers)} differ from QUOTA_READERS '
                               f'{sorted(QUOTA_READERS)} in ops/tests/test_harness_parity.py'))
    return checks


class HarnessParityTest(unittest.TestCase):
    def problems(self, checks):
        failures = [f'  {path}: {message}' for path, message in checks]
        self.assertEqual(failures, [], 'harness parity failures; edit these files:\n' + '\n'.join(failures))

    def test_typescript_harness_id_union_and_definitions_match_descriptors(self):
        names = set(descriptors())
        checks = []
        types = text('packages/adapter-sdk/src/sdk/types.ts')
        match = re.search(r'export type HarnessId = ([^;]+);', types)
        self.assertIsNotNone(match, 'packages/adapter-sdk/src/sdk/types.ts: HarnessId union not found')
        ts_ids = quoted(match.group(1))
        for name in sorted(names - ts_ids):
            checks.append(('packages/adapter-sdk/src/sdk/types.ts', f"add '{name}' to the HarnessId union"))
        for name in sorted(ts_ids - names):
            checks.append(('packages/adapter-sdk/descriptors/', f"add {name}.json or remove '{name}' from HarnessId"))
        index = text('packages/adapter-sdk/src/harnesses/index.ts')
        block = re.search(r'HARNESS_DEFINITIONS[^=]*= \{([^}]+)\}', index, re.S)
        self.assertIsNotNone(block, 'packages/adapter-sdk/src/harnesses/index.ts: HARNESS_DEFINITIONS not found')
        defined = set(re.findall(r'^\s{2}([a-z][a-z0-9_-]*):', block.group(1), re.M))
        for name in sorted(names - defined):
            checks.append(('packages/adapter-sdk/src/harnesses/index.ts', f"add the '{name}' harness definition"))
            checks.append((f'packages/adapter-sdk/src/harnesses/{name}.ts', 'create the harness definition module'))
        self.problems(checks)

    def test_bins_and_session_file_regex_match_descriptors(self):
        names = set(descriptors())
        checks = []
        package = json.loads(text('packages/adapter-sdk/package.json'))
        bins = {key.removeprefix('cauce-adapter-') for key in package['bin'] if key.startswith('cauce-adapter-')}
        for name in sorted(names - bins):
            checks.append(('packages/adapter-sdk/package.json', f"add the cauce-adapter-{name} bin"))
            checks.append((f'packages/adapter-sdk/src/bin/{name}.ts', 'create the adapter bin entrypoint'))
        for name in sorted(bins - names):
            checks.append(('packages/adapter-sdk/package.json', f"remove the cauce-adapter-{name} bin or add its descriptor"))
        session = text('packages/adapter-sdk/src/sdk/durable-store/session-file.ts')
        match = re.search(r'\(\?:([a-z0-9|]+)\):', session)
        self.assertIsNotNone(match, 'session-file.ts harness alternation not found')
        alternation = set(match.group(1).split('|'))
        for name in sorted(names - alternation):
            checks.append(('packages/adapter-sdk/src/sdk/durable-store/session-file.ts',
                           f"add '{name}' to the session key alternation"))
        self.problems(checks)

    def test_gateway_harness_kind_covers_descriptors_except_allowlisted(self):
        names = set(descriptors())
        catalog = text('services/gateway/src/console/agent-documents/catalog.ts')
        match = re.search(r'export type HarnessKind = ([^;]+);', catalog)
        self.assertIsNotNone(match, 'catalog.ts: HarnessKind union not found')
        kinds = quoted(match.group(1)) - {'unknown'}
        checks = [('services/gateway/src/console/agent-documents/catalog.ts',
                     f"add '{name}' to HarnessKind or to GATEWAY_OMITTED in ops/tests/test_harness_parity.py")
                    for name in sorted(names - kinds - GATEWAY_OMITTED)]
        checks += [('services/gateway/src/console/agent-documents/catalog.ts',
                     f"'{name}' is in HarnessKind but has no descriptor") for name in sorted(kinds - names)]
        self.problems(checks)

    def test_console_catalog_names_only_real_descriptors_and_tracks_pending(self):
        names = set(descriptors())
        console_ids = set(re.findall(r"^\s+id: '([a-z][a-z0-9_-]*)',", text('console/src/features/config/arneses.ts'), re.M))
        checks = [('console/src/features/config/arneses.ts', f"'{name}' has no harness descriptor")
                    for name in sorted(console_ids - names)]
        pending = names - console_ids
        checks += [('console/src/features/config/arneses.ts',
                     f"add '{name}' to ARNESES_REALES (or to CONSOLE_PENDING in ops/tests/test_harness_parity.py)")
                    for name in sorted(pending - CONSOLE_PENDING)]
        checks += [('ops/tests/test_harness_parity.py',
                     f"CONSOLE_PENDING still lists '{name}' but the console already covers it; remove it")
                    for name in sorted(CONSOLE_PENDING - pending)]
        self.problems(checks)

    def test_quota_enums_and_sql_check_cover_quota_descriptors(self):
        quota = {name for name, doc in descriptors().items() if 'quota' in doc['operations']}
        checks = []
        sql = text('packages/store/migrations/057_quota_environments.sql')
        match = re.search(r"provider IN \(([^)]+)\)", sql)
        self.assertIsNotNone(match, '057 provider CHECK not found')
        sql_providers = quoted(match.group(1))
        for name in sorted(quota - sql_providers):
            checks.append(('packages/store/migrations/ (new migration, never edit 057)',
                           f"allow quota provider '{name}' from its descriptor"))
        for name in sorted(sql_providers - quota - NON_HARNESS_PROVIDERS):
            checks.append(('packages/store/migrations/057_quota_environments.sql',
                           f"provider '{name}' has no quota descriptor and is not an allowlisted non-harness provider"))
        protocol = text('packages/protocol/src/schemas/quotas.ts')
        match = re.search(r'QuotaEnvironmentProviderSchema = z\.enum\(\[([^\]]+)\]\)', protocol)
        self.assertIsNotNone(match, 'QuotaEnvironmentProviderSchema not found')
        protocol_providers = quoted(match.group(1))
        for name in sorted(quota - protocol_providers):
            checks.append(('packages/protocol/src/schemas/quotas.ts', f"add '{name}' to QuotaEnvironmentProviderSchema"))
        capabilities = text('services/gateway/src/fleet/host-channel.capabilities.ts')
        match = re.search(r'QuotaProvider=z\.enum\(\[([^\]]+)\]\)', capabilities)
        self.assertIsNotNone(match, 'gateway QuotaProvider enum not found')
        gateway_providers = quoted(match.group(1))
        for name in sorted(quota - gateway_providers):
            checks.append(('services/gateway/src/fleet/host-channel.capabilities.ts', f"add '{name}' to the QuotaProvider enum"))
        self.problems(checks)

    def test_fleet_modules_exist_and_are_declared(self):
        checks = []
        docs = descriptors()
        for name, doc in docs.items():
            module = (doc.get('provider') or {}).get('fleet_module')
            if module and not (ROOT / f'ops/cli/{module}.py').exists():
                checks.append((f'ops/cli/{module}.py', f"create the fleet provider module declared by descriptors/{name}.json"))
            expected = f'fleet_provider_{name}'
            if (ROOT / f'ops/cli/{expected}.py').exists() and module != expected:
                checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                               f"declare provider.fleet_module '{expected}'"))
        self.problems(checks)

    def test_quota_readers_and_explicit_no_reader_harnesses_cover_every_descriptor(self):
        docs = descriptors()
        names = set(docs)
        checks = []
        for name in sorted(names - QUOTA_READERS - NO_QUOTA_READER):
            checks.append(('ops/tests/test_harness_parity.py',
                           f"classify '{name}' in QUOTA_READERS (declare operations.quota with a reader) "
                           'or in NO_QUOTA_READER (explicit no-reader harness)'))
        for name in sorted((QUOTA_READERS | NO_QUOTA_READER) - names):
            checks.append(('ops/tests/test_harness_parity.py', f"'{name}' is classified but has no descriptor"))
        for name in sorted(QUOTA_READERS & NO_QUOTA_READER):
            checks.append(('ops/tests/test_harness_parity.py', f"'{name}' is in both quota classifications"))
        for name, doc in sorted(docs.items()):
            operations = doc['operations']
            provider = doc.get('provider') or {}
            if name in QUOTA_READERS:
                if operations.get('quota') != 'quota-collector':
                    checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                                   'declare operations.quota as quota-collector for a measured harness'))
                if not provider.get('quota_argv'):
                    checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                                   'declare provider.quota_argv for a measured harness'))
            if name in NO_QUOTA_READER and ('quota' in operations or 'quota_argv' in provider):
                checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                               'declares a quota reader but is classified as an explicit no-reader harness; '
                               'move it to QUOTA_READERS or remove the operation'))
        self.problems(checks)

    def test_quota_readers_match_store_executor_and_receipt(self):
        self.problems(quota_reader_contract_checks())

    def test_quota_reader_contracts_reject_drift_and_missing_declarations(self):
        sources = {path: text(path) for path in (
            'packages/store/src/agent-quota-operations-model.ts',
            'ops/cli/fleet_executor_agent_quota.py',
            'packages/protocol/src/agent-quota.ts')}
        for path, source in sources.items():
            for altered in (source.replace("'grok'", "'muse'"), ''):
                with self.subTest(path=path, missing=altered == ''):
                    with patch(__name__ + '.text', side_effect={**sources, path: altered}.__getitem__):
                        with self.assertRaisesRegex(AssertionError, re.escape(path)):
                            self.problems(quota_reader_contract_checks())

    def test_harness_definitions_seed_accepts_whitespace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'seed.sql'
            path.write_text("INSERT\nINTO harness_definitions(id, display_name, capabilities) VALUES\n"
                            "  ( 'grok' , 'Grok' , '[\"messages.receive\"]' :: jsonb );")
            rows, checks = seeded_harness_definitions([path])
        self.problems(checks)
        self.assertEqual(rows, {'grok': ('seed.sql', 'Grok', ['messages.receive'])})

    def test_harness_definitions_seed_rejects_inserts_without_parsed_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'seed.sql'
            path.write_text("INSERT INTO harness_definitions(id,display_name,capabilities) VALUES\n"
                            "  ('grok','Grok',jsonb_build_array('messages.receive'));")
            rows, checks = seeded_harness_definitions([path])
        self.assertEqual(rows, {})
        with self.assertRaisesRegex(AssertionError, 'INSERT INTO harness_definitions produced no parsed seed rows'):
            self.problems(checks)

    def test_harness_definitions_seed_matches_descriptors(self):
        docs = descriptors()
        names = set(docs)
        rows, checks = seeded_harness_definitions()
        for name in sorted(names - set(rows)):
            checks.append(('packages/store/migrations/ (new migration, never edit a published one)',
                           f"seed harness_definitions for descriptor '{name}'"))
        for name in sorted(set(rows) - names):
            checks.append((f'packages/store/migrations/{rows[name][0]}',
                           f"harness '{name}' is seeded without a descriptor in packages/adapter-sdk/descriptors/"))
        for name, (migration, display_name, capabilities) in sorted(rows.items()):
            if not display_name.strip():
                checks.append((f'packages/store/migrations/{migration}', f"harness '{name}' seeds an empty display_name"))
            if not capabilities or not all(isinstance(capability, str) for capability in capabilities):
                checks.append((f'packages/store/migrations/{migration}', f"harness '{name}' seeds empty or non-string capabilities"))
            for capability in sorted(set(capabilities) - SEEDED_CAPABILITIES):
                checks.append((f'packages/store/migrations/{migration}',
                               f"harness '{name}' seeds capability '{capability}' outside the closed vocabulary "
                               'in SEEDED_CAPABILITIES (ops/tests/test_harness_parity.py)'))
            if name in docs and docs[name]['operations'].get('execute') != 'native-execution':
                checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                               'a seeded harness must declare native execution'))
        self.problems(checks)

    def test_parsers_share_the_provider_fields(self):
        python = text('ops/cli/harness_operations.py')
        typescript = text('packages/adapter-sdk/src/context/harness-descriptor.ts')
        checks = []
        for field in ('authenticate_argv', 'quota_argv', 'update_package', 'fleet_module'):
            if field not in python:
                checks.append(('ops/cli/harness_operations.py', f'validate provider.{field}'))
            if field not in typescript:
                checks.append(('packages/adapter-sdk/src/context/harness-descriptor.ts', f'validate provider.{field}'))
        self.problems(checks)


if __name__ == '__main__':
    unittest.main()
