import json
import pathlib
import re
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
DESCRIPTORS = ROOT / 'packages/adapter-sdk/descriptors'
# Providers that are not harnesses: they may appear in quota enums without a descriptor.
NON_HARNESS_PROVIDERS = {'gemini', 'minimax', 'feihoa', 'agy'}
# Descriptor harnesses the gateway document catalog does not classify today.
GATEWAY_OMITTED = {'opencode', 'fake', 'fake2'}
# Descriptor harnesses the console catalog has not picked up yet; shrink as it aligns.
CONSOLE_PENDING = {'opencode', 'fake', 'fake2'}
HARNESS_CATALOG = 'packages/store/src/configuration/harness-catalog.ts'
HARNESS_MUTATIONS = 'packages/store/src/configuration/mutations.ts'


def catalog_capabilities(source=None):
    """Closed vocabulary of harness_definitions.capabilities, read from the store module that
    enforces it on every catalog write; the strings are rendered into agent profile facts."""
    source = (ROOT / HARNESS_CATALOG).read_text() if source is None else source
    match = re.search(r'export const HARNESS_CATALOG_CAPABILITIES\b[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)', source)
    return quoted(match.group(1)) if match else set()






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


SEEDED_CAPABILITIES = catalog_capabilities()


def descriptors():
    return {path.stem: json.loads(path.read_text()) for path in sorted(DESCRIPTORS.glob('*.json'))}


def valid_quota_argv(doc):
    argv = (doc.get('provider') or {}).get('quota_argv')
    return isinstance(argv, list) and bool(argv) and all(isinstance(value, str) and value.strip() for value in argv)


def quota_readers(docs=None):
    docs = descriptors() if docs is None else docs
    return {name for name, doc in docs.items()
            if doc.get('operations', {}).get('quota') == 'quota-collector' and valid_quota_argv(doc)}


def valid_authenticate_argv(doc):
    argv = (doc.get('provider') or {}).get('authenticate_argv')
    return isinstance(argv, list) and bool(argv) and all(isinstance(value, str) and value.strip() for value in argv)


def quota_login_providers(docs=None):
    docs = descriptors() if docs is None else docs
    return {name for name, doc in docs.items()
            if doc.get('operations', {}).get('authenticate') == 'provider-login' and valid_authenticate_argv(doc)}


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




class HarnessParityTest(unittest.TestCase):
    def problems(self, checks):
        failures = [f'  {path}: {message}' for path, message in checks]
        self.assertEqual(failures, [], 'harness parity failures; edit these files:\n' + '\n'.join(failures))

    def test_typescript_harness_id_union_and_definitions_match_descriptors(self):
        names = set(descriptors())
        checks = []
        types_path = 'packages/adapter-sdk/src/sdk/types.ts'
        types = text(types_path)
        match = re.search(r'export type HarnessId = ([^;]+);', types)
        self.assertIsNotNone(match, f'{types_path}: HarnessId declaration not found')
        if re.sub(r'\s+', ' ', match.group(1)).strip() != 'string':
            checks.append((types_path, 'keep HarnessId as string; the descriptor grammar closes the id'))
        index_path = 'packages/adapter-sdk/src/harnesses/index.ts'
        index = text(index_path)
        if 'function genericHarnessDefinition(' not in index:
            checks.append((index_path, 'keep genericHarnessDefinition so a descriptor without a handwritten module still runs'))
        block = re.search(r'HARNESS_DEFINITIONS[^=]*= \{([^}]+)\}', index, re.S)
        self.assertIsNotNone(block, f'{index_path}: HARNESS_DEFINITIONS not found')
        defined = set(re.findall(r"^\s*['\"]?([A-Za-z][A-Za-z0-9_-]*)['\"]?\s*:", block.group(1), re.M))
        if 'function genericHarnessDefinition(' not in index:
            for name in sorted(names - defined):
                checks.append((index_path, f"add the '{name}' harness definition"))
                checks.append((f'packages/adapter-sdk/src/harnesses/{name}.ts', 'create the harness definition module'))
        checks += set_parity_checks(index_path, defined - names, set(), 'HARNESS_DEFINITIONS')
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
        session_path = 'packages/adapter-sdk/src/sdk/durable-store/session-file.ts'
        session = text(session_path)
        grammar = '[a-z][a-z0-9_-]{0,63}:[A-Za-z0-9._:-]{1,500}'
        if grammar not in session:
            checks.append((session_path, 'session keys must accept the descriptor id grammar'))
        if re.search(r'\(\?:[a-z0-9_|-]+:', session):
            checks.append((session_path, 'session keys must not list harness names'))
        self.problems(checks)


    def test_quota_enums_and_sql_check_cover_quota_descriptors(self):
        sql_providers, checks = effective_quota_provider_check()
        expected = quota_readers() | quota_login_providers() | (sql_providers & NON_HARNESS_PROVIDERS)
        checks += set_parity_checks('packages/store/migrations/ (new migration, never edit a published one)',
                                   sql_providers, expected, 'effective quota provider CHECK')
        contracts = {
            'packages/protocol/src/schemas/quotas.ts': r'QuotaEnvironmentProviderSchema\s*=\s*z\.enum\(\[([^\]]+)\]\)',
            'services/gateway/src/fleet/host-channel.capabilities.ts': r'QuotaProvider\s*=\s*z\.enum\(\[([^\]]+)\]\)',
            'console/src/api/client/my-quotas-client.ts': r'export type QuotaProvider\s*=\s*([^;]+);',
            'packages/store/src/quota-environments.ts': r'\btype QuotaProvider\s*=\s*([^;]+);',
            'services/gateway/src/fleet/enrolled-main.ts':
                r'\bQuotaCapabilities\s*=\s*z\.object\(\{\s*providers:\s*z\.array\(z\.enum\(\[([^\]]+)\]\)',
        }
        for path, pattern in contracts.items():
            match = re.search(pattern, text(path))
            if not match:
                checks.append((path, 'quota provider enum or union not found'))
            else:
                checks += set_parity_checks(path, quoted(match.group(1)), expected, 'quota provider contract')
        self.problems(checks)


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
            (session, text(session).replace(
                '[a-z][a-z0-9_-]{0,63}:[A-Za-z0-9._:-]{1,500}', '(?:claude|codex):'),
             self.test_bins_and_session_file_regex_match_descriptors),
            (console, text(console).replace(" | 'grok'", ''), self.test_quota_enums_and_sql_check_cover_quota_descriptors),
            (protocol, re.sub(r'(QuotaEnvironmentProviderSchema\s*=\s*z\.enum\(\[)([^\]]+)(\]\))',
                              lambda match: match[1] + match[2] + ", 'ghost'" + match[3], text(protocol)),
             self.test_quota_enums_and_sql_check_cover_quota_descriptors),
        ]
        for path, altered, check in mutations:
            with self.subTest(path=path):
                self.assert_source_mutation_rejected(path, altered, check)

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
        self.assertEqual(quota_readers(docs), expected - {'muse'})
        del docs['grok']['operations']['quota']
        self.assertEqual(quota_readers(docs), expected - {'muse', 'grok'})
        docs['grok']['operations']['quota'] = 'quota-collector'
        for argv in ([], 'read-quota', [''], [None]):
            with self.subTest(argv=argv):
                docs['grok']['provider']['quota_argv'] = argv
                self.assertEqual(quota_readers(docs), expected - {'muse', 'grok'})

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
        for field in ('authenticate_argv', 'quota_argv', 'update_package', 'update_argv', 'fleet_module'):
            if field not in python:
                checks.append(('ops/cli/harness_operations.py', f'validate provider.{field}'))
            if field not in typescript:
                checks.append(('packages/adapter-sdk/src/context/harness-descriptor.ts', f'validate provider.{field}'))
        self.problems(checks)


if __name__ == '__main__':
    unittest.main()
