import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1] / "instances/hospital"
FILES = (
    "bootstrap.sql", "restore-developer-aliases.sql", "rename-developers.sql",
    "backup.sh", "backup-monitor.sh",
)
SQL_STRING = r"'((?:[^']|'')*)'"
MEMBERSHIP_ARRAY = r"active_memberships\s+IS DISTINCT FROM ARRAY\[(.*?)\]::text\[\]"


def only_match(pattern, source):
    matches = re.findall(pattern, source, re.DOTALL)
    assert len(matches) == 1, f"membership parser expected one match: {pattern}"
    return matches[0]


def sql_strings(source):
    values = re.findall(SQL_STRING, source)
    remainder = re.sub(SQL_STRING, "", source)
    assert not remainder.strip(" \n\r\t,"), "unparsed membership SQL literal"
    assert values, "empty membership SQL literal"
    return [value.replace("''", "'") for value in values]


def canonical_members(values, count, label, aliases):
    rows = [tuple(value.split(":")) for value in values]
    assert len(rows) == count, f"{label}: membership count"
    assert all(len(row) == 4 and all(row) for row in rows), f"{label}: membership fields"
    assert rows == sorted(rows, key=lambda row: row[:3]), f"{label}: membership order"
    rows = [(tenant, room, aliases.get(alias, alias), role) for tenant, room, alias, role in rows]
    assert len({row[:3] for row in rows}) == len(rows), f"{label}: duplicate membership"
    return tuple(sorted(rows, key=lambda row: row[:3]))


def rename_mapping(source):
    records = re.findall(
        r"\(\s*'Hospital',\s*'([^']+)',\s*'openclaw',\s*'[^']+',\s*true,\s*"
        r"'hospital-agent-openclaw-(backend|frontend)-gateway-1'", source,
    )
    assert len(records) == 2, "membership alias mapping missing from rename"
    mapping = {old: new for new, old in records}
    assert mapping == {"backend": "teseo", "frontend": "perseo"}, "membership alias mapping drift"
    return mapping


def sql_variants(source, sites, label, aliases):
    arrays = re.findall(MEMBERSHIP_ARRAY, source, re.DOTALL)
    assert len(arrays) == sites * 2, f"{label}: missing membership arrays"
    aggregates = re.findall(
        r"SELECT array_agg\(tenant_id \|\| ':' \|\| room_id \|\| ':' \|\| alias \|\| ':' \|\| role"
        r"\s+ORDER BY tenant_id, room_id, alias\)\s+INTO active_memberships FROM memberships WHERE enabled;",
        source,
    )
    assert len(aggregates) == 2, f"{label}: missing ordered membership aggregates"
    return {
        f"{label}:{site}": {
            count: canonical_members(sql_strings(arrays[site * 2 + offset]), count, label, aliases)
            for offset, count in enumerate((4, 5))
        }
        for site in range(sites)
    }


def restore_guard(source, aliases):
    active_arrays = re.findall(r"active_aliases IS DISTINCT FROM ARRAY\[(.*?)\]::text\[\]", source)
    assert len(active_arrays) == 2, "restore: missing active alias variants"
    prefix, operators, operator_role, agent_role, extra = only_match(
        r"SELECT array_agg\('([^']+)' \|\| alias \|\| ':' \|\|\s+"
        r"CASE WHEN alias IN \((.*?)\) THEN '([^']+)' ELSE '([^']+)' END\s+ORDER BY alias\)"
        r"\s+INTO expected_memberships\s+FROM unnest\(active_aliases \|\| ARRAY\[(.*?)\]::text\[\]\) AS members\(alias\);",
        source,
    )
    supervisor = sql_strings(only_match(
        r"IF active_memberships IS DISTINCT FROM expected_memberships\s+"
        r"AND active_memberships IS DISTINCT FROM \(\s+SELECT array_agg\(member ORDER BY member\)"
        r"\s+FROM unnest\(expected_memberships \|\| ARRAY\[(.*?)\]::text\[\]\)\s+AS members\(member\)\s+\)",
        source,
    ))
    assert len(supervisor) == 1, "restore: optional membership count"
    operators = sql_strings(operators)
    variants = []
    for active in active_arrays:
        members = [
            f"{prefix}{alias}:{operator_role if alias in operators else agent_role}"
            for alias in sorted(sql_strings(active) + sql_strings(extra))
        ]
        variants.append({
            count: canonical_members(sorted(values), count, "restore:guard", aliases)
            for count, values in ((4, members), (5, members + supervisor))
        })
    assert variants[0] == variants[1], "restore: old/new membership variants drift"
    return variants[0]


def backup_variants(source, aliases):
    first, optional, last = only_match(
        r"expected_memberships='([^']*)'\s+if \[ \"\$memberships\" = 5 \]; then"
        r"\s+expected_memberships\+='([^']*)'\s+fi\s+expected_memberships\+='([^']*)'",
        source,
    )
    assert len(re.findall(r"^\s*expected_memberships(?:\+)?=", source, re.MULTILINE)) == 3, (
        "backup: unexpected membership assignments"
    )
    return {
        count: canonical_members((first + extra + last).split(","), count, "backup", aliases)
        for count, extra in ((4, ""), (5, optional))
    }


def same_ast(node, expression):
    return ast.dump(node) == ast.dump(ast.parse(expression, mode="eval").body)


def monitor_variants(source, aliases):
    tree = ast.parse(only_match(r"<<'PY'\n(.*?)\nPY(?:\n|$)", source))
    nodes = list(ast.walk(tree))
    assignments = {}
    for name in ("members", "expected_memberships"):
        found = [node for node in nodes if isinstance(node, ast.Assign)
                 and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                 and node.targets[0].id == name]
        assert len(found) == 1, f"monitor: missing unique {name} assignment"
        assignments[name] = found[0].value
    members = ast.literal_eval(assignments["members"])
    assert isinstance(members, list) and all(isinstance(member, str) for member in members)
    conditions = [node for node in nodes if isinstance(node, ast.If)
                  and same_ast(node.test, 'evidence.get("membership_count") == 5')]
    assert len(conditions) == 1, "monitor: missing optional membership condition"
    optional = conditions[0]
    assert not optional.orelse and len(optional.body) == 1 and isinstance(optional.body[0], ast.Expr)
    insert = optional.body[0].value
    assert isinstance(insert, ast.Call) and len(insert.args) == 2, "monitor: missing insert"
    index, supervisor = [ast.literal_eval(argument) for argument in insert.args]
    assert same_ast(insert, f"members.insert({index!r}, {supervisor!r})"), "monitor: unexpected insert"
    expected = assignments["expected_memberships"]
    assert isinstance(expected, ast.Call) and len(expected.args) == 1
    generator = expected.args[0]
    assert isinstance(generator, ast.GeneratorExp) and isinstance(generator.elt, ast.JoinedStr)
    assert len(generator.elt.values) == 2 and isinstance(generator.elt.values[0], ast.Constant)
    prefix = generator.elt.values[0].value
    assert isinstance(prefix, str) and same_ast(
        expected, f'",".join(f"{prefix}{{member}}" for member in members)'
    ), "monitor: unexpected membership formatter"
    for check in ('evidence.get("membership_count") != len(members)',
                  'membership_topology != expected_memberships'):
        assert any(same_ast(node, check) for node in nodes), f"monitor: missing receipt check {check}"
    expanded = list(members)
    expanded.insert(index, supervisor)
    return {
        count: canonical_members([prefix + member for member in values], count, "monitor", aliases)
        for count, values in ((4, members), (5, expanded))
    }


def assert_consistent(sources):
    aliases = rename_mapping(sources["rename-developers.sql"])
    sites = sql_variants(sources["bootstrap.sql"], 2, "bootstrap", {})
    sites.update(sql_variants(sources["restore-developer-aliases.sql"], 1, "restore:verify", aliases))
    sites["restore:guard"] = restore_guard(sources["restore-developer-aliases.sql"], aliases)
    sites["backup"] = backup_variants(sources["backup.sh"], {})
    sites["monitor"] = monitor_variants(sources["backup-monitor.sh"], {})
    assert len(sites) == 6, "membership validation site count"
    expected = sites["bootstrap:0"]
    for label, variants in sites.items():
        for count in (4, 5):
            assert variants[count] == expected[count], f"{label}: {count}-member membership drift"
    return sites


@pytest.fixture
def sources():
    return {name: (ROOT / name).read_text(encoding="utf-8") for name in FILES}


def test_membership_topologies_match_at_all_six_sites(sources):
    assert_consistent(sources)


@pytest.mark.parametrize("filename, index", [
    ("bootstrap.sql", index) for index in range(4)
] + [("restore-developer-aliases.sql", index) for index in range(2)])
def test_detects_drift_in_every_literal_array(sources, filename, index):
    source = sources[filename]
    arrays = list(re.finditer(MEMBERSHIP_ARRAY, source, re.DOTALL))
    start, end = arrays[index].span(1)
    changed = source[start:end].replace(":operator", ":agent", 1)
    assert changed != source[start:end]
    sources[filename] = source[:start] + changed + source[end:]
    with pytest.raises(AssertionError, match="membership"):
        assert_consistent(sources)


@pytest.mark.parametrize("filename, old, new", [
    ("bootstrap.sql", "Hospital:grp.hospital:perseo:agent", "Hospital:grp.hospital:perseo:operator"),
    ("bootstrap.sql", "Hospital:grp.hospital:teseo:agent", "Other:grp.hospital:teseo:agent"),
    ("bootstrap.sql", "Hospital:grp.hospital:teseo:agent", "Hospital:other:teseo:agent"),
    ("bootstrap.sql", "Hospital:grp.hospital:teseo:agent", "Hospital:grp.hospital:zeta:agent"),
    ("restore-developer-aliases.sql", "Hospital:grp.hospital:backend:agent", "Hospital:grp.hospital:backend:operator"),
    ("restore-developer-aliases.sql", "THEN 'operator' ELSE 'agent'", "THEN 'agent' ELSE 'agent'"),
    ("restore-developer-aliases.sql", "Hospital:grp.hospital:praxis-supervisor:operator", "Hospital:grp.hospital:praxis-supervisor:agent"),
    ("backup.sh", "Hospital:grp.hospital:teseo:agent", "Hospital:grp.hospital:teseo:operator"),
    ("backup-monitor.sh", '"perseo:agent"', '"perseo:operator"'),
    ("backup-monitor.sh", 'members.insert(3, "praxis-supervisor:operator")', 'members.insert(3, "praxis-supervisor:agent")'),
])
def test_detects_semantic_drift_in_each_source(sources, filename, old, new):
    assert old in sources[filename]
    sources[filename] = sources[filename].replace(old, new, 1)
    with pytest.raises(AssertionError, match="membership"):
        assert_consistent(sources)


@pytest.mark.parametrize("replacement", [
    "'Hospital:grp.hospital:console-proxy:operator', 'Hospital:grp.hospital:console-proxy:operator'",
    "'Hospital:grp.hospital:operador:operator', 'Hospital:grp.hospital:console-proxy:operator'",
    "'Hospital:grp.hospital:console-proxy:operator'",
])
def test_rejects_duplicate_reordered_or_missing_members(sources, replacement):
    original = "'Hospital:grp.hospital:console-proxy:operator', 'Hospital:grp.hospital:operador:operator'"
    sources["bootstrap.sql"] = sources["bootstrap.sql"].replace(original, replacement, 1)
    with pytest.raises(AssertionError, match="membership"):
        assert_consistent(sources)


@pytest.mark.parametrize("filename, old, new", [
    ("bootstrap.sql", "active_memberships IS DISTINCT FROM ARRAY[", "active_memberships = ARRAY["),
    ("restore-developer-aliases.sql", "INTO expected_memberships", "INTO other_memberships"),
    ("backup.sh", 'if [ "$memberships" = 5 ]; then', 'if [ "$memberships" = 4 ]; then'),
    ("backup-monitor.sh", 'evidence.get("membership_count") == 5', 'evidence.get("membership_count") == 4'),
    ("backup-monitor.sh", 'members.insert(3, "praxis-supervisor:operator")', 'members.insert(0, "praxis-supervisor:operator")'),
    ("rename-developers.sql", "hospital-agent-openclaw-backend-gateway-1", "hospital-agent-openclaw-other-gateway-1"),
])
def test_fails_closed_when_validation_structure_changes(sources, filename, old, new):
    assert old in sources[filename]
    sources[filename] = sources[filename].replace(old, new, 1)
    with pytest.raises(AssertionError, match="membership|memberships"):
        assert_consistent(sources)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
