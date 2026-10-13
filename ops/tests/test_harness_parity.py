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
    return set(re.findall(r"['\"]([^'\"]*)['\"]", segment))


def descriptors():
    return {path.stem: json.loads(path.read_text()) for path in sorted(DESCRIPTORS.glob('*.json'))}


def valid_quota_argv(doc):
    argv = (doc.get('provider') or {}).get('quota_argv')
    return isinstance(argv, list) and bool(argv) and all(isinstance(value, str) and value.strip() for value in argv)


def quota_readers(docs=None):
    docs = descriptors() if docs is None else docs
    return {name for name, doc in docs.items()
            if doc.get('operations', {}).get('quota') == 'quota-collector' and valid_quota_argv(doc)}


def set_parity_checks(path, actual, expected, label):
    checks = [(path, f"{label} is missing '{name}'") for name in sorted(expected - actual)]
    return checks + [(path, f"{label} has unexpected '{name}'") for name in sorted(actual - expected)]


def effective_quota_provider_check(paths=None):
    constraints, checks = {}, []
    migrations = (ROOT / 'packages/store/migrations').glob('*.sql') if paths is None else paths
    for path in sorted(migrations):
        source = text(path.relative_to(ROOT).as_posix()) if paths is None else path.read_text()
        source = re.sub(r'/\*.*?\*/|--[^\n]*', '', source, flags=re.S)
        for statement in source.split(';'):
            create = re.search(r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?quota_environments\s*\(', statement, re.I)
            alter = re.search(r'\bALTER\s+TABLE\s+(?:ONLY\s+)?quota_environments\b', statement, re.I)
            if re.search(r'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?quota_environments\b', statement, re.I):
                constraints.clear()
            if not create and not alter:
                continue
            if create:
                constraints.clear()
            actions = list(re.finditer(
                r'\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(?P<drop>[a-z_][a-z0-9_]*)'
                r'|(?:\bCONSTRAINT\s+(?P<name>[a-z_][a-z0-9_]*)\s+)?'
                r'\bCHECK\s*\(\s*provider\s+IN\s*\((?P<providers>[^)]*)\)\s*\)', statement, re.I))
            for action in actions:
                if action.group('drop'):
                    constraints.pop(action.group('drop').lower(), None)
                else:
                    name = (action.group('name') or 'quota_environments_provider_check').lower()
                    if not re.fullmatch(r"\s*'[^']*'\s*(?:,\s*'[^']*'\s*)*", action.group('providers')):
                        checks.append((f'packages/store/migrations/{path.name}', 'provider CHECK contains a nonliteral value'))
                    if action.group('name') and name in constraints:
                        checks.append((f'packages/store/migrations/{path.name}', f"provider CHECK '{name}' is added without dropping it"))
                    if not action.group('name'):
                        suffix = 1
                        while name in constraints:
                            name = f'quota_environments_provider_check{suffix}'
                            suffix += 1
                    constraints[name] = (path.name, quoted(action.group('providers')))
            provider_checks = re.findall(r'\bCHECK\s*\(\s*provider\b', statement, re.I)
            parsed_checks = [action for action in actions if action.group('providers') is not None]
            if len(provider_checks) != len(parsed_checks):
                checks.append((f'packages/store/migrations/{path.name}', 'provider CHECK is not a parsed closed IN contract'))
    if not constraints:
        checks.append(('packages/store/migrations/', 'effective quota_environments provider CHECK not found'))
        return set(), checks
    providers = set.intersection(*(values for _, values in constraints.values()))
    return providers, checks


def store_quota_reader_contract_checks(source):
    path = 'packages/store/src/agent-quota-operations-model.ts'
    match = re.search(r'export async function readAgentQuotaPlacement\b(.*?)(?=\nexport |\Z)', source, re.S)
    body = match.group(1) if match else ''
    body = re.sub(r'/\*.*?\*/|//[^\n]*', '', body, flags=re.S)
    query = re.search(r'const row = \(await client\.query[^`]*`([^`]+)`\s*,\s*\[([^\]]+)\]\)\)\.rows\[0\]', body, re.S)
    if not query:
        return [(path, 'active quota placement query not found')]
    sql, parameters = query.groups()
    checks = []
    if not re.search(r'const quotaReaders\s*=\s*await approvedAgentQuotaHarnesses\(\)', body):
        checks.append((path, 'quota placement must load approved descriptor readers for each query'))
    if re.search(r'\bharness_id\s+IN\s*\(', sql, re.I):
        checks.append((path, 'active quota placement query contains a literal harness reader list'))
    slots = re.findall(r'\b(?:agent\.)?harness_id\s*=\s*ANY\s*\(\s*\$(\d+)\s*::\s*text\[\]\s*\)', sql, re.I)
    args = [value.strip() for value in parameters.split(',')]
    if len(slots) != 2 or any(int(slot) > len(args) or args[int(slot) - 1] != 'quotaReaders' for slot in slots):
        checks.append((path, 'both active quota predicates must bind the approved quotaReaders array'))
    return checks


def quota_reader_contract_checks():
    contracts = {
        'ops/cli/fleet_executor_agent_quota.py': r'\bPROVIDERS\s*=\s*frozenset\s*\(\s*\{([^}]*)\}\s*\)',
        'packages/protocol/src/agent-quota.ts':
            r'\bAgentQuotaReceiptSchema\s*=\s*z\.discriminatedUnion\b.*?\bprovider:\s*z\.enum\(\[([^\]]*)\]\)',
    }
    expected = quota_readers()
    checks = store_quota_reader_contract_checks(text('packages/store/src/agent-quota-operations-model.ts'))
    for path, pattern in contracts.items():
        matches = re.findall(pattern, text(path), re.S)
        if not matches:
            checks.append((path, 'quota reader contract not found'))
        for match in matches:
            readers = quoted(match)
            checks += set_parity_checks(path, readers, expected, 'descriptor quota reader contract')
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
            checks.append(('packages/adapter-sdk/src/sdk/types.ts', f"add {name}.json or remove '{name}' from HarnessId"))
        index = text('packages/adapter-sdk/src/harnesses/index.ts')
        block = re.search(r'HARNESS_DEFINITIONS[^=]*= \{([^}]+)\}', index, re.S)
        self.assertIsNotNone(block, 'packages/adapter-sdk/src/harnesses/index.ts: HARNESS_DEFINITIONS not found')
        defined = set(re.findall(r"^\s*['\"]?([A-Za-z][A-Za-z0-9_-]*)['\"]?\s*:", block.group(1), re.M))
        for name in sorted(names - defined):
            checks.append(('packages/adapter-sdk/src/harnesses/index.ts', f"add the '{name}' harness definition"))
            checks.append((f'packages/adapter-sdk/src/harnesses/{name}.ts', 'create the harness definition module'))
        checks += set_parity_checks('packages/adapter-sdk/src/harnesses/index.ts', defined - names, set(),
                                    'HARNESS_DEFINITIONS')
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
        match = re.search(r'\(\?:([a-z0-9_|-]+)\):', session)
        self.assertIsNotNone(match, 'session-file.ts harness alternation not found')
        alternation = set(match.group(1).split('|'))
        for name in sorted(names - alternation):
            checks.append(('packages/adapter-sdk/src/sdk/durable-store/session-file.ts',
                           f"add '{name}' to the session key alternation"))
        checks += set_parity_checks('packages/adapter-sdk/src/sdk/durable-store/session-file.ts',
                                    alternation - names, set(), 'session key alternation')
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
        checks += [('ops/tests/test_harness_parity.py', f"GATEWAY_OMITTED has stale '{name}'")
                   for name in sorted(GATEWAY_OMITTED - (names - kinds))]
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
        sql_providers, checks = effective_quota_provider_check()
        expected = quota_readers() | (sql_providers & NON_HARNESS_PROVIDERS)
        checks += set_parity_checks('packages/store/migrations/ (new migration, never edit a published one)',
                                   sql_providers, expected, 'effective quota provider CHECK')
        contracts = {
            'packages/protocol/src/schemas/quotas.ts': r'QuotaEnvironmentProviderSchema\s*=\s*z\.enum\(\[([^\]]+)\]\)',
            'services/gateway/src/fleet/host-channel.capabilities.ts': r'QuotaProvider\s*=\s*z\.enum\(\[([^\]]+)\]\)',
            'console/src/api/client/my-quotas-client.ts': r'export type QuotaProvider\s*=\s*([^;]+);',
        }
        for path, pattern in contracts.items():
            match = re.search(pattern, text(path))
            if not match:
                checks.append((path, 'quota provider enum or union not found'))
            else:
                checks += set_parity_checks(path, quoted(match.group(1)), expected, 'quota provider contract')
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

    def test_quota_readers_require_operation_and_valid_argv(self):
        docs = descriptors()
        checks = []
        for name, doc in sorted(docs.items()):
            operations = doc['operations']
            provider = doc.get('provider') or {}
            if 'quota' in operations:
                if operations.get('quota') != 'quota-collector':
                    checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                                   'declare operations.quota as quota-collector for a measured harness'))
                if not valid_quota_argv(doc):
                    checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                                   'declare provider.quota_argv for a measured harness'))
            if 'quota_argv' in provider and 'quota' not in operations:
                checks.append((f'packages/adapter-sdk/descriptors/{name}.json',
                               'declares provider.quota_argv without operations.quota'))
        self.problems(checks)

    def test_quota_readers_match_store_executor_and_receipt(self):
        self.problems(quota_reader_contract_checks())

    def test_quota_reader_contracts_reject_drift_and_missing_declarations(self):
        sources = {path: text(path) for path in (
            'ops/cli/fleet_executor_agent_quota.py',
            'packages/protocol/src/agent-quota.ts')}
        original = text
        for path, source in sources.items():
            for altered in (source.replace("'grok'", "'muse'"), ''):
                with self.subTest(path=path, missing=altered == ''):
                    with patch(__name__ + '.text', side_effect=lambda requested, altered=altered, path=path:
                               altered if requested == path else original(requested)):
                        with self.assertRaisesRegex(AssertionError, re.escape(path)):
                            self.problems(quota_reader_contract_checks())

    def assert_source_mutation_rejected(self, path, altered, check, failure_path=None):
        original = text
        self.assertNotEqual(altered, original(path), f'{path}: mutation did not alter the source')
        with patch(__name__ + '.text', side_effect=lambda requested: altered if requested == path else original(requested)):
            with self.assertRaisesRegex(AssertionError, re.escape(failure_path or path)):
                check()

    def test_four_reported_mutations_are_rejected(self):
        index = 'packages/adapter-sdk/src/harnesses/index.ts'
        session = 'packages/adapter-sdk/src/sdk/durable-store/session-file.ts'
        console = 'console/src/api/client/my-quotas-client.ts'
        protocol = 'packages/protocol/src/schemas/quotas.ts'
        mutations = [
            (index, text(index).replace('  hermes: hermesDefinition,', '  ghost: hermesDefinition,\n  hermes: hermesDefinition,'),
             self.test_typescript_harness_id_union_and_definitions_match_descriptors),
            (session, re.sub(r'\(\?:([a-z0-9_|-]+)\):', r'(?:\1|ghost):', text(session)),
             self.test_bins_and_session_file_regex_match_descriptors),
            (console, text(console).replace(" | 'grok'", ''), self.test_quota_enums_and_sql_check_cover_quota_descriptors),
            (protocol, re.sub(r'(QuotaEnvironmentProviderSchema\s*=\s*z\.enum\(\[)([^\]]+)(\]\))',
                              lambda match: match[1] + match[2] + ", 'muse'" + match[3], text(protocol)),
             self.test_quota_enums_and_sql_check_cover_quota_descriptors),
        ]
        for path, altered, check in mutations:
            with self.subTest(path=path):
                self.assert_source_mutation_rejected(path, altered, check)

    def test_harness_contracts_reject_missing_and_extra_ids(self):
        types = 'packages/adapter-sdk/src/sdk/types.ts'
        index = 'packages/adapter-sdk/src/harnesses/index.ts'
        session = 'packages/adapter-sdk/src/sdk/durable-store/session-file.ts'
        gateway = 'services/gateway/src/console/agent-documents/catalog.ts'
        mutations = [
            (types, text(types).replace('export type HarnessId = ', "export type HarnessId = 'ghost' | "),
             self.test_typescript_harness_id_union_and_definitions_match_descriptors),
            (types, text(types).replace("'grok' | ", ''), self.test_typescript_harness_id_union_and_definitions_match_descriptors),
            (index, text(index).replace('  grok: grokDefinition,', ''), self.test_typescript_harness_id_union_and_definitions_match_descriptors),
            (session, text(session).replace('|grok|', '|'), self.test_bins_and_session_file_regex_match_descriptors),
            (gateway, text(gateway).replace('export type HarnessKind = ', "export type HarnessKind = 'ghost' | "),
             self.test_gateway_harness_kind_covers_descriptors_except_allowlisted),
        ]
        for path, altered, check in mutations:
            with self.subTest(path=path):
                self.assert_source_mutation_rejected(path, altered, check)

    def test_quota_contracts_reject_missing_extra_and_non_harness_drift(self):
        paths = ('packages/protocol/src/schemas/quotas.ts', 'services/gateway/src/fleet/host-channel.capabilities.ts',
                 'console/src/api/client/my-quotas-client.ts')
        for path in paths:
            source = text(path)
            for provider, replacement in (('grok', 'ghost'), ('gemini', 'muse'), ('claude', 'minimax')):
                with self.subTest(path=path, provider=provider):
                    self.assert_source_mutation_rejected(path, source.replace(f"'{provider}'", f"'{replacement}'"),
                                                         self.test_quota_enums_and_sql_check_cover_quota_descriptors)
        path = 'packages/store/migrations/057_quota_environments.sql'
        self.assert_source_mutation_rejected(path, text(path).replace("'claude','codex','gemini','grok'", "'claude','codex','gemini'"),
                                             self.test_quota_enums_and_sql_check_cover_quota_descriptors, 'packages/store/migrations/')

    def test_quota_readers_follow_descriptor_addition_removal_and_argv(self):
        docs = descriptors()
        expected = quota_readers(docs)
        docs['ghost'] = {**docs['grok'], 'harness': 'ghost'}
        self.assertEqual(quota_readers(docs), expected | {'ghost'})
        del docs['ghost']
        self.assertEqual(quota_readers(docs), expected)
        docs['muse']['operations']['quota'] = 'quota-collector'
        docs['muse']['provider']['quota_argv'] = ['/usr/bin/read-quota']
        self.assertEqual(quota_readers(docs), expected | {'muse'})
        del docs['muse']['operations']['quota']
        self.assertEqual(quota_readers(docs), expected)
        del docs['grok']['operations']['quota']
        self.assertEqual(quota_readers(docs), expected - {'grok'})
        docs['grok']['operations']['quota'] = 'quota-collector'
        for argv in ([], 'read-quota', [''], [None]):
            with self.subTest(argv=argv):
                docs['grok']['provider']['quota_argv'] = argv
                self.assertEqual(quota_readers(docs), expected - {'grok'})

    def test_store_quota_contract_rejects_literal_dead_or_unbound_sql(self):
        path = 'packages/store/src/agent-quota-operations-model.ts'
        source = text(path)
        changes = (
            re.sub(r'agent\.harness_id\s*=\s*ANY\(\$5::text\[\]\)', "agent.harness_id IN ('codex','claude','grok')", source),
            source.replace('const quotaReaders = await approvedAgentQuotaHarnesses();', "const quotaReaders = ['codex', 'claude', 'grok'];"),
            source.replace('const quotaReaders = await approvedAgentQuotaHarnesses();',
                           "// const quotaReaders = await approvedAgentQuotaHarnesses();\nconst quotaReaders = ['codex'];"),
            source.replace(', quotaReaders]', ', []]'),
            source.replace('const row = (await client.query', 'const unusedRow = (await client.query'),
        )
        for index, altered in enumerate(changes):
            with self.subTest(mutation=index):
                self.assertNotEqual(altered, source)
                with self.assertRaisesRegex(AssertionError, re.escape(path)):
                    self.problems(store_quota_reader_contract_checks(altered))

    def test_effective_quota_sql_applies_later_migrations_and_combined_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            initial = pathlib.Path(directory) / '001.sql'
            initial.write_text("CREATE TABLE quota_environments (provider text CHECK (provider IN ('codex','gemini')));")
            updated = pathlib.Path(directory) / '002.sql'
            updated.write_text('ALTER TABLE quota_environments DROP CONSTRAINT quota_environments_provider_check, '
                               "ADD CONSTRAINT quota_environments_provider_check CHECK (provider IN ('grok','gemini')); "
                               "-- CHECK (provider IN ('ghost'))\n")
            providers, checks = effective_quota_provider_check([updated, initial])
        self.problems(checks)
        self.assertEqual(providers, {'grok', 'gemini'})

    def test_effective_quota_sql_intersects_active_checks_and_rejects_missing_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / '001.sql'
            path.write_text("CREATE TABLE quota_environments (provider text CHECK (provider IN ('codex','grok')), "
                            "CONSTRAINT extra CHECK (provider IN ('grok','gemini')));")
            providers, checks = effective_quota_provider_check([path])
            self.problems(checks)
            self.assertEqual(providers, {'grok'})
            path.write_text("CREATE TABLE quota_environments (provider text CHECK (provider IN ('codex'))); "
                            'ALTER TABLE quota_environments DROP CONSTRAINT quota_environments_provider_check;')
            providers, checks = effective_quota_provider_check([path])
            self.assertEqual(providers, set())
            with self.assertRaisesRegex(AssertionError, 'effective quota_environments provider CHECK not found'):
                self.problems(checks)
            path.write_text("CREATE TABLE quota_environments (provider text CHECK (provider IN ('codex') OR provider='grok'));")
            _, checks = effective_quota_provider_check([path])
            with self.assertRaisesRegex(AssertionError, 'not a parsed closed IN contract'):
                self.problems(checks)

    def test_parity_rejects_differently_indented_and_invalid_harness_ids(self):
        index = 'packages/adapter-sdk/src/harnesses/index.ts'
        self.assert_source_mutation_rejected(index, text(index).replace('  hermes: hermesDefinition,',
                                                                       '    Ghost: hermesDefinition,\n  hermes: hermesDefinition,'),
                                             self.test_typescript_harness_id_union_and_definitions_match_descriptors)
        path = 'packages/protocol/src/schemas/quotas.ts'
        self.assert_source_mutation_rejected(path, re.sub(r'(QuotaEnvironmentProviderSchema\s*=\s*z\.enum\(\[)',
                                                         r"\1'Ghost', ", text(path)),
                                             self.test_quota_enums_and_sql_check_cover_quota_descriptors)

    def test_effective_quota_sql_rejects_dynamic_values_and_duplicate_named_constraints(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / '001.sql'
            for source, failure in (
                ("CREATE TABLE quota_environments (provider text CHECK (provider IN ('codex', current_user)));", 'nonliteral value'),
                ("CREATE TABLE quota_environments (provider text CONSTRAINT readers CHECK (provider IN ('codex'))); "
                 "ALTER TABLE quota_environments ADD CONSTRAINT readers CHECK (provider IN ('grok'));", 'without dropping it'),
            ):
                with self.subTest(failure=failure):
                    path.write_text(source)
                    _, checks = effective_quota_provider_check([path])
                    with self.assertRaisesRegex(AssertionError, failure):
                        self.problems(checks)

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
