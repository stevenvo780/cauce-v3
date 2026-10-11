import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Room ids are unique per company, not per installation: `rooms` is keyed by (tenant_id, id) and the
 * same id may name a room of another company. Any SQL that reaches `rooms` by its id must also bind
 * the tenant (or the company) of that room, or it reads and locks rooms it does not own.
 */

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_ROOTS = ['packages', 'services'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'test', 'tests', 'test-support', 'migrations']);
const NON_PRODUCTION = /\.(?:test|fixtures?|spec)\.ts$/u;
const SQL_KEYWORDS = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'using',
  'order', 'group', 'limit', 'for', 'union', 'returning', 'window', 'set', 'as', 'having', 'offset']);
const CLAUSE_END = /^(?:order\s+by|group\s+by|limit|union|returning|for\s+(?:share|update|no\s+key|key))\b/iu;

interface RoomsReference { readonly line: number; readonly clause: string; readonly unbound: boolean }

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !NON_PRODUCTION.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The rest of the statement level the reference opened: until a closing parenthesis, a clause end or the literal end. */
function clauseAfter(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0 || character === '`' || character === ';'
      || (depth === 0 && /\s/u.test(text[index - 1] ?? '') && CLAUSE_END.test(text.slice(index, index + 16)))) {
      return text.slice(start, index);
    }
  }
  return text.slice(start);
}

/** The select list of the statement level that reaches `end`, nested groups emptied; '' when that level selects nothing. */
function selectListBefore(text: string, end: number): string {
  let depth = 0;
  let index = end - 1;
  for (; index >= 0; index -= 1) {
    const character = text[index];
    if (character === ')') depth += 1;
    if (character === '(') depth -= 1;
    if (depth < 0 || character === '`' || character === ';') break;
  }
  let level = text.slice(index + 1, end);
  for (let previous = ''; previous !== level;) { previous = level; level = level.replace(/\([^()]*\)/gu, '()'); }
  const selects = [...level.matchAll(/\bselect\b/giu)];
  const last = selects.at(-1);
  return last === undefined ? '' : level.slice(last.index + last[0].length);
}

function escaped(identifier: string): string {
  return identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Every `FROM`, `JOIN` or `UPDATE` of rooms, or `'rooms WHERE ...'` fragment spliced into one, and whether it reaches a
 * room by id without its tenant or company: in the clause that follows, in a `USING` list, or as a selected id
 * (`room_id IN (SELECT id FROM rooms ...)`). Table names computed at run time stay outside any static lint.
 */
function roomsReferences(text: string): RoomsReference[] {
  return [...text.matchAll(/\b(?:from|join|update)\s+rooms\b|(?<=['"`]\s*)rooms(?=\s+where\b)/giu)].map((match) => {
    const start = match.index + match[0].length;
    const declared = /^\s+(?:as\s+)?([a-z_][a-z0-9_]*)/iu.exec(text.slice(start))?.[1];
    const alias = declared !== undefined && !SQL_KEYWORDS.has(declared.toLowerCase()) ? declared : undefined;
    const clause = clauseAfter(text, start);
    const qualifier = alias === undefined ? '(?:rooms\\.)?' : `${escaped(alias)}\\.`;
    const column = (name: string, prefix = qualifier): RegExp => new RegExp(`(?<![\\w.])${prefix}${name}\\b`, 'iu');
    const owner = '(?:tenant_id|company_id)';
    const bound = column(owner).test(clause);
    const using = /\busing\s*\(([^)]*)\)/iu.exec(clause)?.[1] ?? '';
    const selected = selectListBefore(text, match.index);
    const selectedQualifier = `(?:${alias === undefined ? 'rooms' : escaped(alias)}\\.)?`;
    return {
      line: text.slice(0, match.index).split('\n').length,
      clause: clause.replace(/\s+/gu, ' ').trim(),
      unbound: (column('id').test(clause) && !bound)
        || (column('id', '').test(using) && !column(owner, '').test(using))
        || (column('id', selectedQualifier).test(selected) && !column(owner, selectedQualifier).test(selected) && !bound),
    };
  });
}

function scan(): { references: number; unbound: { file: string; line: number; clause: string }[] } {
  const files = SOURCE_ROOTS.flatMap((root) => readdirSync(join(REPOSITORY, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sources = join(REPOSITORY, root, entry.name, 'src');
      try { return sourceFiles(sources); } catch { return []; }
    }));
  let references = 0;
  const unbound = files.flatMap((path) => {
    const found = roomsReferences(readFileSync(path, 'utf8'));
    references += found.length;
    return found.filter((reference) => reference.unbound)
      .map((reference) => ({ file: relative(REPOSITORY, path), line: reference.line, clause: reference.clause }));
  });
  return { references, unbound };
}

describe('SQL that reaches rooms binds the tenant of the room', () => {
  it('flags a room reached by id alone and accepts one bound to its tenant or company', () => {
    const unbound = (sql: string): boolean[] => roomsReferences(sql).map((reference) => reference.unbound);
    expect(unbound('SELECT 1 FROM memberships m JOIN rooms room ON room.id=m.room_id WHERE m.enabled')).toEqual([true]);
    expect(unbound('JOIN rooms room ON room.id=m.room_id AND room.tenant_id=m.tenant_id')).toEqual([false]);
    expect(unbound('JOIN rooms r ON r.id=$1 WHERE r.company_id=$2 ORDER BY r.id')).toEqual([false]);
    expect(unbound('EXISTS(SELECT 1 FROM rooms WHERE rooms.id=memberships.room_id AND rooms.purged_at IS NULL)')).toEqual([true]);
    expect(unbound('SELECT purged_at FROM rooms WHERE tenant_id=$1 AND id=$2')).toEqual([false]);
    expect(unbound('SELECT * FROM rooms WHERE id=$1')).toEqual([true]);
    expect(unbound('SELECT * FROM rooms r WHERE r.tenant_id=t.id')).toEqual([false]);
    expect(unbound('FROM rooms room JOIN role_policies p ON p.role=$3 WHERE room.id=$1 AND room.tenant_id=$2')).toEqual([false]);
    expect(unbound('JOIN rooms target_room ON target_room.id=x.room_id) WHERE target_room.tenant_id=x.tenant_id')).toEqual([true]);
    expect(unbound('UPDATE rooms SET enabled=false WHERE id=$1 RETURNING tenant_id')).toEqual([true]);
    expect(unbound('UPDATE rooms SET enabled=false WHERE tenant_id=$1 AND id=$2')).toEqual([false]);
    expect(unbound('WHERE m.room_id IN (SELECT id FROM rooms WHERE enabled)')).toEqual([true]);
    expect(unbound('WHERE m.room_id IN (SELECT DISTINCT r.id FROM rooms r WHERE r.enabled)')).toEqual([true]);
    expect(unbound('WHERE m.room_id IN (SELECT id FROM rooms WHERE tenant_id=m.tenant_id)')).toEqual([false]);
    expect(unbound('WHERE (m.tenant_id,m.room_id) IN (SELECT tenant_id,id FROM rooms WHERE enabled)')).toEqual([false]);
    expect(unbound('SELECT count(*),(SELECT id FROM x LIMIT 1) FROM rooms WHERE enabled')).toEqual([false]);
    expect(unbound('SELECT m.id FROM messages m JOIN rooms r ON r.tenant_id=m.tenant_id AND r.id=m.room_id')).toEqual([false]);
    expect(unbound('FROM memberships m JOIN rooms r USING (id) WHERE m.enabled')).toEqual([true]);
    expect(unbound('FROM memberships m JOIN rooms USING (id)')).toEqual([true]);
    expect(unbound('FROM memberships m JOIN rooms r USING (tenant_id,id)')).toEqual([false]);
    expect(unbound("const source = 'rooms WHERE id=$1';")).toEqual([true]);
    expect(unbound("const source = 'rooms WHERE tenant_id=$1 AND id=$2';")).toEqual([false]);
  });

  it('finds no production statement that reaches a room by id without its tenant', () => {
    const { references, unbound } = scan();
    expect(references).toBeGreaterThan(40);
    expect(unbound).toEqual([]);
  });
});
