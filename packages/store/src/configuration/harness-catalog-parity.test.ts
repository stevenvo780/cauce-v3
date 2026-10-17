import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertPublishedHarnessDefinition, type HarnessCatalogChange } from './harness-catalog.js';

const PACKAGED = new URL('../../../adapter-sdk/descriptors/', import.meta.url);
const MIGRATIONS = new URL('../../migrations/', import.meta.url);

interface SeedFile { readonly name: string; readonly sql: string }
interface SeededRow { readonly id: string; readonly command: unknown; readonly capabilities: unknown; readonly file: string }
interface SeededPatch { readonly id: string; readonly change: HarnessCatalogChange; readonly file: string }

/** Splits on commas that sit outside quotes and brackets, so a JSON array stays one value. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === "'") {
        if (text[index + 1] === "'") index += 1;
        else quoted = false;
      }
    } else if (char === "'") quoted = true;
    else if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The parenthesised tuples after VALUES, ignoring the ON CONFLICT tail. */
function valueTuples(sql: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    if (quoted) {
      if (char === "'") {
        if (sql[index + 1] === "'") index += 1;
        else quoted = false;
      }
    } else if (char === "'") quoted = true;
    else if (char === '(') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        tuples.push(sql.slice(start + 1, index));
        start = -1;
      }
    }
  }
  return tuples;
}

/** A SQL literal as a JS value; a non-literal expression stays raw text so validation rejects it. */
function literal(raw: string): unknown {
  const text = raw.trim().replace(/::\s*[a-z]+(?:\s*\([^)]*\))?$/iu, '').trim();
  if (/^NULL$/iu.test(text)) return null;
  const quoted = /^'((?:[^']|'')*)'$/su.exec(text);
  return quoted ? quoted[1]?.replace(/''/gu, "'") : text;
}

function jsonLiteral(raw: string): unknown {
  const value = literal(raw);
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function collectSeeds(files: readonly SeedFile[]): { rows: SeededRow[]; patches: SeededPatch[]; errors: string[] } {
  const rows: SeededRow[] = [];
  const patches: SeededPatch[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const statement of file.sql.matchAll(/INSERT\s+INTO\s+harness_definitions\b[\s\S]*?;/giu)) {
      const header = /INSERT\s+INTO\s+harness_definitions\s*\(([^)]*)\)\s*VALUES\b/iu.exec(statement[0]);
      if (!header?.[1]) {
        errors.push(`${file.name}: seed insert without an explicit column list cannot be checked`);
        continue;
      }
      const columns = header[1].split(',').map(column => column.trim().toLowerCase());
      const valuesSql = statement[0].slice(statement[0].toUpperCase().indexOf('VALUES') + 'VALUES'.length)
        .split(/\bON\s+CONFLICT\b/iu)[0] ?? '';
      for (const tuple of valueTuples(valuesSql)) {
        const values = splitTopLevel(tuple);
        if (values.length !== columns.length) {
          errors.push(`${file.name}: seed row has ${String(values.length)} values for ${String(columns.length)} columns`);
          continue;
        }
        const byColumn = new Map(columns.map((column, index) => [column, values[index] ?? '']));
        const id = literal(byColumn.get('id') ?? '');
        if (typeof id !== 'string' || id === '') {
          errors.push(`${file.name}: seed row without a literal harness id cannot be checked`);
          continue;
        }
        if (seen.has(id)) errors.push(`${file.name}: harness '${id}' is seeded more than once`);
        seen.add(id);
        rows.push({ id, file: file.name,
          command: byColumn.has('command') ? literal(byColumn.get('command') ?? '') : null,
          capabilities: byColumn.has('capabilities') ? jsonLiteral(byColumn.get('capabilities') ?? '') : undefined });
      }
    }
    for (const statement of file.sql.matchAll(/UPDATE\s+harness_definitions\b[\s\S]*?;/giu)) {
      const change: { command?: unknown; capabilities?: unknown } = {};
      const command = /\bcommand\s*=\s*('(?:[^']|'')*'|NULL)/iu.exec(statement[0]);
      const capabilities = /\bcapabilities\s*=\s*('(?:[^']|'')*')/iu.exec(statement[0]);
      if (command?.[1] !== undefined) change.command = literal(command[1]);
      if (capabilities?.[1] !== undefined) change.capabilities = jsonLiteral(capabilities[1]);
      if (change.command === undefined && change.capabilities === undefined) continue;
      const id = /\bWHERE\s+id\s*=\s*'((?:[^']|'')*)'/iu.exec(statement[0])?.[1]?.replace(/''/gu, "'");
      if (!id) errors.push(`${file.name}: seed update of command/capabilities without a literal id cannot be checked`);
      else patches.push({ id, change, file: file.name });
    }
  }
  return { rows, patches, errors };
}

async function migrationSeeds(): Promise<{ rows: SeededRow[]; patches: SeededPatch[]; errors: string[] }> {
  const files: SeedFile[] = [];
  for (const name of (await readdir(MIGRATIONS)).filter(entry => entry.endsWith('.sql')).sort()) {
    files.push({ name, sql: await readFile(new URL(name, MIGRATIONS), 'utf8') });
  }
  return collectSeeds(files);
}

async function divergence(row: { id: string; file: string }, change: HarnessCatalogChange): Promise<string | undefined> {
  try {
    await assertPublishedHarnessDefinition(row.id, change);
    return undefined;
  } catch (error) {
    return `${row.file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

describe('harness_definitions seeds match the published descriptors', () => {
  it('seeds exactly the published harnesses, each row with a null command and closed capabilities', async () => {
    const descriptorIds = (await readdir(PACKAGED)).filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -5));
    const { rows, patches, errors } = await migrationSeeds();
    const failures = [...errors];
    const seededIds = new Set(rows.map(row => row.id));
    for (const id of descriptorIds) {
      if (!seededIds.has(id)) failures.push(`missing seed for published descriptor '${id}'`);
    }
    for (const row of rows) {
      if (!descriptorIds.includes(row.id)) failures.push(`${row.file}: seeded harness '${row.id}' has no published descriptor`);
      const problem = await divergence(row, { command: row.command, capabilities: row.capabilities });
      if (problem) failures.push(problem);
    }
    for (const patch of patches) {
      const problem = await divergence(patch, patch.change);
      if (problem) failures.push(problem);
    }
    expect(failures).toEqual([]);
  });

  it('rejects a seeded command, a repeated or unknown capability and an undescribed harness', async () => {
    const cases: [string, HarnessCatalogChange, RegExp][] = [
      [`INSERT INTO harness_definitions(id,display_name,command,capabilities) VALUES
        ('codex','Codex','/usr/local/bin/codex','["messages.receive"]'::jsonb);`,
        { command: '/usr/local/bin/codex' }, /^harness\.command:/u],
      [`INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
        ('codex','Codex','["messages.receive","messages.receive"]'::jsonb);`,
        { capabilities: ['messages.receive', 'messages.receive'] }, /^harness\.capabilities: 'messages\.receive' is repeated/u],
      [`INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
        ('codex','Codex','["tools"]'::jsonb);`,
        { capabilities: ['tools'] }, /^harness\.capabilities: 'tools' is outside the closed vocabulary/u],
      [`INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
        ('ghost','Ghost','["messages.receive"]'::jsonb);`,
        {}, /^harness\.id: 'ghost': no published descriptor/u],
    ];
    for (const [sql, change, message] of cases) {
      const { rows, errors } = collectSeeds([{ name: 'seed.sql', sql }]);
      expect(errors).toEqual([]);
      expect(rows).toHaveLength(1);
      const parsed = rows[0] as SeededRow;
      expect({ command: parsed.command, capabilities: parsed.capabilities }).toEqual(expect.objectContaining(change));
      await expect(assertPublishedHarnessDefinition(parsed.id, { command: parsed.command, capabilities: parsed.capabilities }))
        .rejects.toThrow(message);
    }
  });

  it('flags a harness seeded twice and a later update that diverges', async () => {
    const duplicated = collectSeeds([{ name: 'seed.sql', sql: `
      INSERT INTO harness_definitions(id,display_name,capabilities) VALUES ('codex','Codex','["messages.receive"]'::jsonb);
      INSERT INTO harness_definitions(id,display_name,capabilities) VALUES ('codex','Codex','["jobs.batch"]'::jsonb);` }]);
    expect(duplicated.errors).toEqual([`seed.sql: harness 'codex' is seeded more than once`]);
    const updated = collectSeeds([{ name: 'seed.sql', sql:
      `UPDATE harness_definitions SET command='/usr/local/bin/codex' WHERE id='codex';` }]);
    expect(updated.errors).toEqual([]);
    expect(updated.patches).toEqual([{ id: 'codex', change: { command: '/usr/local/bin/codex' }, file: 'seed.sql' }]);
    await expect(assertPublishedHarnessDefinition('codex', { command: '/usr/local/bin/codex' }))
      .rejects.toThrow(/^harness\.command:/u);
  });
});
