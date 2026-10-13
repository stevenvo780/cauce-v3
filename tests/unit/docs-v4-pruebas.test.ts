import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inventory = readFileSync(join(repository, 'docs/v4-pruebas.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const crudMatrix = JSON.parse(readFileSync(join(repository, 'docs/v4-matriz-crud.json'), 'utf8')) as {
  pending: unknown[];
};

const ignoredDirectories = new Set(['.git', '.claude', '.delegados', '__pycache__', 'coverage', 'dist', 'node_modules']);
const testSource = /\.test\.(?:ts|tsx|mjs|js)$/u;
const postgresTest = /(?:-postgres|\.postgres|\.pg)\.test\.ts$/u;

interface Definition {
  id: string;
  countCommand: string;
  execution: string;
  count: () => number;
}

function filesWithin(roots: string[], maxSubdirectories = Number.POSITIVE_INFINITY): string[] {
  const files: string[] = [];

  const visit = (absoluteDirectory: string, depth: number): void => {
    if (!existsSync(absoluteDirectory)) return;
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = relative(repository, absolutePath);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith('.') && depth < maxSubdirectories) {
          visit(absolutePath, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  for (const root of roots) visit(join(repository, root), 0);
  return files.sort();
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index] ?? '';
    if (character === '|' && line[index - 1] === '\\') {
      cell = `${cell.slice(0, -1)}|`;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function documentRows(): Map<string, string[]> {
  return new Map(
    inventory.split('\n')
      .filter(line => line.startsWith('|'))
      .map(splitTableRow)
      .filter(cells => cells.length === 6 && cells[0] !== 'ID' && cells[0] !== '---')
      .map(cells => [cells[0] ?? '', cells]),
  );
}

function documentedCountCommands(): Map<string, string> {
  const commands = new Map<string, string>();
  for (const line of inventory.split('\n')) {
    const match = /^- `([^`]+)`: `(.+)`$/u.exec(line);
    if (match) commands.set(match[1] ?? '', match[2] ?? '');
  }
  return commands;
}

const definitions: Definition[] = [
  {
    id: 'unitarias',
    countCommand: "find tests/unit packages/protocol/test packages/store/src packages/adapter-sdk/test packages/mcp-fleet-monitor services/decisiones/test console -type d \\( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \\) -prune -o -type f \\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs' -o -name '*.test.js' \\) -print | wc -l",
    execution: 'pnpm test:unit',
    count: () => filesWithin([
      'tests/unit', 'packages/protocol/test', 'packages/store/src', 'packages/adapter-sdk/test',
      'packages/mcp-fleet-monitor', 'services/decisiones/test', 'console',
    ]).filter(file => testSource.test(file)).length,
  },
  {
    id: 'postgres',
    countCommand: "find tests packages services -type d \\( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \\) -prune -o -type f \\( -name '*-postgres.test.ts' -o -name '*.postgres.test.ts' -o -name '*.pg.test.ts' \\) -print | wc -l",
    execution: 'pnpm test',
    count: () => filesWithin(['tests', 'packages', 'services']).filter(file => postgresTest.test(file)).length,
  },
  {
    id: 'navegador',
    countCommand: "find tests/e2e -maxdepth 1 -type f -name '*real-browser*.test.*' -print | wc -l",
    execution: 'pnpm test:e2e',
    count: () => filesWithin(['tests/e2e'], 0).filter(file => /real-browser.*\.test\./u.test(basename(file))).length,
  },
  {
    id: 'fallos',
    countCommand: "find tests/integration ops/tests -type d \\( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \\) -prune -o -type f \\( -name 'failure-drill*' -o -name 'test-fault*.sh' \\) -print | wc -l",
    execution: 'pnpm test:integration && pnpm test:ops',
    count: () => filesWithin(['tests/integration', 'ops/tests'])
      .filter(file => basename(file).startsWith('failure-drill') || /^test-fault.*\.sh$/u.test(basename(file))).length,
  },
  {
    id: 'aislamiento',
    countCommand: "find tests/gateway-hardening tests/store-hardening services/gateway/src/security/route-isolation.postgres.test.ts -type f -name '*.test.ts' -print | wc -l",
    execution: 'pnpm test:gateway-hardening && pnpm test:store-hardening && pnpm test:services',
    count: () => filesWithin(['tests/gateway-hardening', 'tests/store-hardening'])
      .filter(file => file.endsWith('.test.ts')).length
      + Number(existsSync(join(repository, 'services/gateway/src/security/route-isolation.postgres.test.ts'))),
  },
  {
    id: 'ops',
    countCommand: 'node ops/tests/run-all.mjs --list | wc -l',
    execution: 'pnpm test:ops',
    count: () => filesWithin(['ops/tests'], 0)
      .filter(file => basename(file).endsWith('.test.mjs') || /^test[-_].*\.(?:py|sh)$/u.test(basename(file))).length,
  },
  {
    id: 'layout',
    countCommand: "find console/qa -maxdepth 1 -type f -name '*.mjs' -print | wc -l",
    execution: 'pnpm qa:layout',
    count: () => filesWithin(['console/qa'], 0).filter(file => file.endsWith('.mjs')).length,
  },
  {
    id: 'release',
    countCommand: "find scripts -maxdepth 1 -type f -name 'release-gates.sh' -print | wc -l",
    execution: 'scripts/release-gates.sh',
    count: () => filesWithin(['scripts'], 0).filter(file => basename(file) === 'release-gates.sh').length,
  },
];

describe('inventario de pruebas de V4', () => {
  test('los conteos documentados coinciden con los archivos encontrados por glob', () => {
    const rows = documentRows();
    expect([...rows.keys()].sort()).toEqual(definitions.map(({ id }) => id).sort());

    for (const definition of definitions) {
      const row = rows.get(definition.id);
      expect(row, `falta la fila ${definition.id}`).toBeDefined();
      expect(Number(row?.[2]), `conteo ${definition.id}`).toBe(definition.count());
    }
  });

  test('los comandos documentados existen en package.json o como script de release', () => {
    const rows = documentRows();
    for (const definition of definitions) {
      const command = (rows.get(definition.id)?.[3] ?? '').replaceAll('`', '');
      expect(command, `comando ${definition.id}`).toBe(definition.execution);
      for (const match of command.matchAll(/\bpnpm\s+([a-z][\w:-]*)/gu)) {
        const script = match[1] ?? '';
        expect(manifest.scripts[script], `falta pnpm ${script} en package.json`).toBeDefined();
      }
    }

    const releaseCommand = execFileSync('bash', [join(repository, 'scripts/release-gates.sh'), '--list'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim().split('\n');
    expect(releaseCommand).toHaveLength(9);
    expect(inventory).toContain('ejecuta nueve gates en secuencia');
  });

  test('el pendiente de la matriz CRUD coincide con el límite descrito', () => {
    const browserRow = documentRows().get('navegador')?.[5] ?? '';
    expect(browserRow).toContain(`matriz mantiene ${String(crudMatrix.pending.length)} pendientes`);
  });

  test('los comandos de conteo reproducen los números documentados', () => {
    const documented = documentedCountCommands();
    expect([...documented.keys()].sort()).toEqual(definitions.map(({ id }) => id).sort());
    for (const definition of definitions) {
      const command = documented.get(definition.id);
      expect(command, `comando de conteo ${definition.id}`).toBe(definition.countCommand);
      const output = execFileSync('bash', ['-o', 'pipefail', '-c', command ?? ''], {
        cwd: repository,
        encoding: 'utf8',
      }).trim();
      expect(Number(output), `resultado del conteo ${definition.id}`).toBe(definition.count());
    }
  });
});
