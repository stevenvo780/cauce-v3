#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const checker = String.raw`
import ast
import pathlib
import sys

def main_guard(node):
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    left, right = test.left, test.comparators[0]
    return any(isinstance(name, ast.Name) and name.id == "__name__"
               and isinstance(value, ast.Constant) and value.value == "__main__"
               for name, value in ((left, right), (right, left)))

def executable_nodes(nodes):
    for node in nodes:
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(node, ast.If) and isinstance(node.test, ast.Constant):
            yield from executable_nodes(node.body if node.test.value else node.orelse)
        else:
            yield from executable_nodes(ast.iter_child_nodes(node))

def propagates_exit(call, parents, returns_exit):
    parent = parents.get(call)
    if isinstance(parent, ast.Return):
        return returns_exit
    if not isinstance(parent, ast.Call) or parent.args != [call]:
        return False
    if isinstance(parent.func, ast.Attribute) and isinstance(parent.func.value, ast.Name):
        return parent.func.value.id == "sys" and parent.func.attr == "exit"
    return (isinstance(parent.func, ast.Name) and parent.func.id == "SystemExit"
            and isinstance(parents.get(parent), ast.Raise))

def launches_tests(nodes, functions, collections, seen=frozenset(), returns_exit=False):
    parents = {child: node for node in executable_nodes(nodes) for child in ast.iter_child_nodes(node)}
    for node in executable_nodes(nodes):
        if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and isinstance(node.iter, ast.Name):
            values = collections.get(node.iter.id, [])
            if values and all(isinstance(value, ast.Name) and value.id.startswith("test_")
                              and value.id in functions for value in values):
                if any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                       and call.func.id == node.target.id for call in executable_nodes(node.body)):
                    return True
        if not isinstance(node, ast.Call):
            continue
        propagates = propagates_exit(node, parents, returns_exit)
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            if node.func.attr == "main":
                if node.func.value.id == "pytest" and propagates:
                    return True
                if node.func.value.id == "unittest" and all(
                        keyword.arg != "exit" or isinstance(keyword.value, ast.Constant)
                        and bool(keyword.value.value) for keyword in node.keywords):
                    return True
        if isinstance(node.func, ast.Name) and node.func.id in functions and node.func.id not in seen:
            name = node.func.id
            if name.startswith(("test_", "scenario_")):
                return True
            body = functions[name].body
            if not propagates and any(isinstance(part, ast.Return) and part.value is not None
                                      for part in executable_nodes(body)):
                continue
            if launches_tests(body, functions, collections, seen | {name}, propagates):
                return True
    return False

failures = []
for filename in sys.argv[1:]:
    source = pathlib.Path(filename)
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=filename)
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        collections = {target.id: node.value.elts for node in tree.body if isinstance(node, ast.Assign)
                       and isinstance(node.value, (ast.List, ast.Tuple)) for target in node.targets
                       if isinstance(target, ast.Name)}
        if not any(main_guard(node) and launches_tests(node.body, functions, collections) for node in tree.body):
            failures.append(f"{source.name}: missing __main__ block that runs tests")
    except (SyntaxError, UnicodeError) as error:
        failures.append(f"{source.name}: invalid Python: {error}")
if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
print(f"lint-pytest-main ok: {len(sys.argv) - 1} Python suites execute tests under __main__")
`;

const files = readdirSync(here, { withFileTypes: true })
  .filter(entry => entry.isFile() && /^test[-_].*\.py$/u.test(entry.name))
  .map(entry => path.join(here, entry.name))
  .sort();
assert.ok(files.length > 0, 'no Python ops suites discovered');
const coverage = spawnSync('python3', ['-c', checker, ...files], { encoding: 'utf8', timeout: 30_000 });
assert.equal(coverage.error, undefined, String(coverage.error));
assert.equal(coverage.status, 0, coverage.stderr);
process.stdout.write(coverage.stdout);

if (!process.argv.includes('--check-only')) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cauce-pytest-main-'));
  try {
    const copy = path.join(temporary, path.basename(self));
    const fixture = path.join(temporary, 'test_fixture.py');
    copyFileSync(self, copy);
    const cases = [
      ['missing', 'def test_value():\n    assert True\n'],
      ['comment', '# if __name__ == "__main__": unittest.main()\n'],
      ['noop', 'if __name__ == "__main__":\n    print("passed")\n'],
      ['noop-main', 'def main():\n    pass\nif __name__ == "__main__":\n    main()\n'],
      ['dormant', 'if __name__ == "__main__":\n    if False:\n        unittest.main()\n'],
      ['pytest-return-discarded', 'if __name__ == "__main__":\n    pytest.main([__file__, "-q"])\n'],
      ['unittest-exit-false', 'if __name__ == "__main__":\n    unittest.main(exit=False)\n'],
      ['main-return-discarded', 'def main():\n    return pytest.main([__file__, "-q"])\nif __name__ == "__main__":\n    main()\n'],
      ['main-caught-failure', 'def test_value():\n    assert False\ndef main():\n    try:\n        test_value()\n    except AssertionError:\n        return 1\n    return 0\nif __name__ == "__main__":\n    main()\n'],
      ['system-exit-not-raised', 'if __name__ == "__main__":\n    SystemExit(pytest.main([__file__, "-q"]))\n'],
      ['pytest', 'if __name__ == "__main__":\n    raise SystemExit(pytest.main([__file__, "-q"]))\n'],
      ['pytest-sys-exit', 'if __name__ == "__main__":\n    sys.exit(pytest.main([__file__, "-q"]))\n'],
      ['main-system-exit', 'def main():\n    return pytest.main([__file__, "-q"])\nif __name__ == "__main__":\n    raise SystemExit(main())\n'],
      ['main-sys-exit', 'def main():\n    return pytest.main([__file__, "-q"])\nif __name__ == "__main__":\n    sys.exit(main())\n'],
      ['unittest', 'if "__main__" == __name__:\n    unittest.main()\n'],
    ];
    for (const [name, source] of cases) {
      writeFileSync(fixture, source);
      const result = spawnSync(process.execPath, [copy, '--check-only'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.error, undefined, String(result.error));
      const expected = ['pytest', 'pytest-sys-exit', 'main-system-exit', 'main-sys-exit', 'unittest'].includes(name) ? 0 : 1;
      assert.equal(result.status, expected, `${name}: ${result.stdout}${result.stderr}`);
      if (expected === 1) assert.match(result.stderr, /test_fixture\.py: missing __main__ block that runs tests/u);
      console.log(`lint-pytest-main fixture ${name}: exit ${result.status} (expected ${expected})`);
    }

    const root = path.join(temporary, 'runner');
    const tests = path.join(root, 'ops/tests');
    mkdirSync(tests, { recursive: true });
    mkdirSync(path.join(root, 'scripts'));
    const runner = path.join(tests, 'run-all.mjs');
    copyFileSync(path.join(here, 'run-all.mjs'), runner);
    writeFileSync(path.join(root, 'scripts/test-all.mjs'), "export const SUITES = ['test:ops'];\n");
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    const timedFixture = path.join(tests, 'deadline.test.mjs');
    const timedCases = [
      ['override', '// cauce:timeout-ms 10000\n', '100', 'PASS'],
      ['default', '', '100', 'TIMEOUT'],
      ['shorter-override', '// cauce:timeout-ms 30\n', '1000', 'TIMEOUT'],
      ['late-header', `${'// padding\n'.repeat(20)}// cauce:timeout-ms 1000\n`, '100', 'TIMEOUT'],
      ['zero', '// cauce:timeout-ms 0\n', '1000', 'FAIL'],
      ['negative', '// cauce:timeout-ms -1\n', '1000', 'FAIL'],
      ['not-a-number', '// cauce:timeout-ms nope\n', '1000', 'FAIL'],
      ['timer-overflow', '// cauce:timeout-ms 2147483648\n', '1000', 'FAIL'],
      ['conflict', '// cauce:timeout-ms 1000\n// cauce:timeout-ms 500\n', '1000', 'FAIL'],
    ];
    for (const [name, header, timeout, verdict] of timedCases) {
      writeFileSync(timedFixture, `${header}setTimeout(() => console.log('fixture completed'), 150);\n`);
      const result = spawnSync(process.execPath, [runner], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, CAUCE_OPS_TEST_TIMEOUT_MS: timeout },
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, verdict === 'PASS' ? 0 : 1, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^${verdict}  deadline\\.test\\.mjs  `, 'mu'));
      if (verdict === 'FAIL') assert.doesNotMatch(result.stdout, /fixture completed/u);
      console.log(`ops deadline fixture ${name}: ${verdict} (exit ${result.status})`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
