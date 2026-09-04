import type { DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

/**
 * Read and write side of the context journal (migration 041): what an alias' profile said in each
 * version, and which governance file was rewritten for it. The profile side is written by the
 * database trigger, never from here; this class only reads it back.
 */

const MAX_JOURNAL_PAGE = 200;

/**
 * Both journals of 041 key on `bigserial`, so a cursor is a positive `bigint` written in base ten
 * and nothing else. The route that publishes the cursor imports this ONE fence: the SQL casts the
 * value to `bigint`, and a second copy of the pattern drifting from this one would reach the base
 * as a cast error instead of as a refusal the caller can read.
 */
export function isJournalCursor(value: unknown): value is string {
  return typeof value === 'string'
    && /^[1-9][0-9]{0,18}$/u.test(value)
    && BigInt(value) <= MAX_JOURNAL_ID;
}

const MAX_JOURNAL_ID = 9223372036854775807n;

const profileColumns =
  'id,tenant_id,alias,revision,operation,purpose,role_summary,human_brief,'
  + 'responsibilities,restrictions,tools,operating_rules,actor_tenant,actor_alias,changed_at';

const documentColumns =
  'id,tenant_id,alias,kind,path,sha256,bytes,actor_tenant,actor_alias,written_at';

export type ProfileRevisionOperation = 'insert' | 'update' | 'delete';

/**
 * One past version of the seven authored fields. The arrays are never null to the caller: the
 * console restores a snapshot by handing it straight to the canonical PUT, and a null there would
 * become a field the restore silently drops.
 */
export interface ProfileRevisionEntry {
  readonly id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly operation: ProfileRevisionOperation;
  readonly purpose: string | null;
  readonly role_summary: string | null;
  readonly human_brief: string | null;
  readonly responsibilities: readonly string[];
  readonly restrictions: readonly string[];
  readonly tools: readonly string[];
  readonly operating_rules: readonly string[];
  /** NULL means "not recorded", never "nobody". */
  readonly actor_tenant: string | null;
  readonly actor_alias: string | null;
  readonly changed_at: string;
}

/** A governance write, by fingerprint. There is no column able to hold the body. */
export interface DocumentRevisionEntry {
  readonly id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly kind: string;
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly actor_tenant: string | null;
  readonly actor_alias: string | null;
  readonly written_at: string;
}

export interface DocumentRevisionInput {
  readonly tenantId: string;
  readonly alias: string;
  readonly kind: string;
  readonly path: string;
  /** NULL only when the write left the file absent. */
  readonly sha256: string | null;
  readonly bytes: number;
  readonly actorTenant: string | null;
  readonly actorAlias: string | null;
}

interface ProfileRevisionRow {
  id: string;
  tenant_id: string;
  alias: string;
  revision: string | number;
  operation: string;
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[] | null;
  restrictions: string[] | null;
  tools: string[] | null;
  operating_rules: string[] | null;
  actor_tenant: string | null;
  actor_alias: string | null;
  changed_at: Date;
}

interface DocumentRevisionRow {
  id: string;
  tenant_id: string;
  alias: string;
  kind: string;
  path: string;
  sha256: string | null;
  bytes: string | number;
  actor_tenant: string | null;
  actor_alias: string | null;
  written_at: Date;
}

function boundedPage(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOURNAL_PAGE) {
    throw new StoreError('invalid_input', 'context journal page size is out of range');
  }
  return limit;
}

function boundedCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!isJournalCursor(cursor)) {
    throw new StoreError('invalid_input', 'context journal cursor is not a journal id');
  }
  return cursor;
}

/**
 * One stretch of a journal, and the id to resume from. `next_cursor` is a string only when a row
 * OLDER than this page really exists: the query asks for one row beyond the page and that extra
 * row, never a full page, is what proves there is more. Saying otherwise would make the reader
 * walk forever off the end of the diary.
 */
export interface JournalPage<Entry> {
  readonly entries: readonly Entry[];
  readonly next_cursor: string | null;
}

function toPage<Row, Entry extends { readonly id: string }>(
  rows: readonly Row[], limit: number, map: (row: Row) => Entry,
): JournalPage<Entry> {
  const entries = rows.slice(0, limit).map(map);
  const last = entries[entries.length - 1];
  return {
    entries,
    next_cursor: rows.length > limit && last !== undefined ? last.id : null,
  };
}

/**
 * The base fences what a journal row may CONTAIN — `sha256` has to be a canonical digest and
 * `bytes` a non-negative count, so no column can hold a body. The SHAPE of the path is fenced
 * here: `041` only demands a leading `/` and a length, which still admits a relative traversal
 * dressed as an absolute path. There is a single trusted writer, and that is the reason to state
 * the rule where the writer is, instead of assuming it.
 */
const MAX_JOURNAL_PATH = 4096;

function boundedPath(path: string): string {
  const segments = path.split('/');
  if (!path.startsWith('/') || path.length < 2 || path.length > MAX_JOURNAL_PATH
    || path.includes('\0')
    || segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new StoreError(
      'invalid_input', 'context journal path is not a canonical absolute path',
    );
  }
  return path;
}

function boundedRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StoreError('invalid_input', 'context journal revision is out of range');
  }
  return revision;
}

function operationOf(value: string): ProfileRevisionOperation {
  if (value !== 'insert' && value !== 'update' && value !== 'delete') {
    throw new StoreError('invalid_input', 'context journal returned an unknown operation');
  }
  return value;
}

function countOf(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StoreError('invalid_input', `context journal returned an invalid ${field}`);
  }
  return parsed;
}

function toProfileEntry(row: ProfileRevisionRow): ProfileRevisionEntry {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    alias: row.alias,
    revision: countOf(row.revision, 'revision'),
    operation: operationOf(row.operation),
    purpose: row.purpose,
    role_summary: row.role_summary,
    human_brief: row.human_brief,
    responsibilities: row.responsibilities ?? [],
    restrictions: row.restrictions ?? [],
    tools: row.tools ?? [],
    operating_rules: row.operating_rules ?? [],
    actor_tenant: row.actor_tenant,
    actor_alias: row.actor_alias,
    changed_at: row.changed_at.toISOString(),
  };
}

function toDocumentEntry(row: DocumentRevisionRow): DocumentRevisionEntry {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    alias: row.alias,
    kind: row.kind,
    path: row.path,
    sha256: row.sha256,
    bytes: countOf(row.bytes, 'byte count'),
    actor_tenant: row.actor_tenant,
    actor_alias: row.actor_alias,
    written_at: row.written_at.toISOString(),
  };
}

export class AgentContextRevisionsStore {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Newest first: the console renders the journal top-down and restores from the top. The cursor
   * only ever NARROWS: it rides on top of the tenant and alias predicate, so a cursor minted for
   * another alias moves the window without ever reaching that alias' rows.
   */
  async listProfileRevisions(
    tenantId: string, alias: string, limit: number, cursor?: string,
  ): Promise<JournalPage<ProfileRevisionEntry>> {
    const page = boundedPage(limit);
    const desde = boundedCursor(cursor);
    const result = await this.pool.query<ProfileRevisionRow>(
      `SELECT ${profileColumns} FROM agent_profile_revisions
        WHERE tenant_id=$1 AND alias=$2 AND ($4::bigint IS NULL OR id < $4::bigint)
        ORDER BY id DESC LIMIT $3`,
      [tenantId, alias, page + 1, desde],
    );
    return toPage(result.rows, page, toProfileEntry);
  }

  /**
   * One version by number. `revision` is not unique — an alias dropped and re-created starts at 1
   * again — so the LATEST row carrying that number wins, which is the one a restore means.
   */
  async readProfileRevision(
    tenantId: string, alias: string, revision: number,
  ): Promise<ProfileRevisionEntry | undefined> {
    const result = await this.pool.query<ProfileRevisionRow>(
      `SELECT ${profileColumns} FROM agent_profile_revisions
        WHERE tenant_id=$1 AND alias=$2 AND revision=$3 ORDER BY id DESC LIMIT 1`,
      [tenantId, alias, boundedRevision(revision)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toProfileEntry(row);
  }

  async listDocumentRevisions(
    tenantId: string, alias: string, kind: string, limit: number, cursor?: string,
  ): Promise<JournalPage<DocumentRevisionEntry>> {
    const page = boundedPage(limit);
    const desde = boundedCursor(cursor);
    const result = await this.pool.query<DocumentRevisionRow>(
      `SELECT ${documentColumns} FROM agent_document_revisions
        WHERE tenant_id=$1 AND alias=$2 AND kind=$3 AND ($5::bigint IS NULL OR id < $5::bigint)
        ORDER BY id DESC LIMIT $4`,
      [tenantId, alias, kind, page + 1, desde],
    );
    return toPage(result.rows, page, toDocumentEntry);
  }

  /**
   * The document side has no trigger: the gateway is the only writer, and it writes AFTER the
   * probe attested the bytes. The body never travels — only its digest and its size.
   */
  async recordDocumentRevision(input: DocumentRevisionInput): Promise<DocumentRevisionEntry> {
    const result = await this.pool.query<DocumentRevisionRow>(
      `INSERT INTO agent_document_revisions(
         tenant_id,alias,kind,path,sha256,bytes,actor_tenant,actor_alias
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${documentColumns}`,
      [
        input.tenantId, input.alias, input.kind, boundedPath(input.path), input.sha256,
        countOf(input.bytes, 'byte count'), input.actorTenant, input.actorAlias,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new StoreError('conflict', 'the context journal did not return the recorded row');
    }
    return toDocumentEntry(row);
  }
}
