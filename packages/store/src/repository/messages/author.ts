import { StoreError } from '../errors.js';
import { messageClientOrigin } from './client-origin.js';

export interface ConsoleMessageAuthor {
  readonly kind: 'human';
  readonly subject_id: string;
  readonly display_name: string | null;
}

export function messageAuthor(value: unknown): ConsoleMessageAuthor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const author = value as Record<string, unknown>;
  if (Object.keys(author).length !== 3 || author.kind !== 'human'
      || typeof author.subject_id !== 'string' || !/^human:[a-f0-9]{64}$/u.test(author.subject_id)
      || (author.display_name !== null && (typeof author.display_name !== 'string'
        || author.display_name.trim().length === 0 || author.display_name.length > 240))) return undefined;
  return { kind: 'human', subject_id: author.subject_id, display_name: author.display_name };
}

export function requireConsoleAuthor(value: unknown, prepared: boolean): ConsoleMessageAuthor | undefined {
  if (value === undefined) return undefined;
  const author = messageAuthor(value);
  if (!prepared || author === undefined) {
    throw new StoreError('forbidden', 'human provenance requires an authenticated console intent');
  }
  return author;
}

/** The trace index bounds the lookup; every durable binding must agree and be unambiguous. */
export const MESSAGE_AUTHOR_SQL = `(SELECT CASE WHEN count(*)=1
  THEN jsonb_agg(author_audit.metadata->'console_author')->0 ELSE NULL END
  FROM audit_events author_audit
  WHERE author_audit.trace_id=m.trace_id AND author_audit.request_id=m.request_id
    AND author_audit.message_id=m.id AND author_audit.tenant_id=m.tenant_id
    AND author_audit.actor_alias=m.actor_alias
    AND author_audit.action='message.publish' AND author_audit.decision='allow') AS author`;

export function withMessageAuthor<T extends object>(row: T): T & { author: ConsoleMessageAuthor | null } {
  const projected = row as T & { author?: unknown; client_origin?: unknown };
  return { ...row, author: messageAuthor(projected.author) ?? null,
    ...(Object.hasOwn(projected, 'client_origin')
      ? { client_origin: messageClientOrigin(projected.client_origin) } : {}) };
}
