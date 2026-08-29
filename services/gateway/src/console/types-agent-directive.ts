export interface AgentDirectiveFile {
  path?: string | null;
  /** 'user' = ~/.claude/CLAUDE.md; 'workspace' = ~/CLAUDE.md or /workspace/CLAUDE.md. */
  scope?: 'user' | 'workspace' | null;
  /** Effective load order, lowest to highest. */
  precedence?: number | null;
  /** Real SHA-256; lets duplicate content across levels be detected without comparing truncated text. */
  sha?: string | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** The file text. May be truncated to MAX_DOCUMENT_BYTES (256 KB). */
  text?: string | null;
  /** true if `text` was trimmed. */
  truncated?: boolean | null;
  /** A failure other than not_found keeps its discriminant; it is not surfaced as absence. */
  error?:
    | 'permission_denied' | 'invalid_path' | 'symlink_detected' | 'too_large'
    | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown' | null;
  reason?: string | null;
}

export interface AgentMemoryIndexAvailable {
  root?: string | null;
  /** Exact total; null means only `observed_at_least` is known. */
  total?: number | null;
  /** Measured lower bound, even when the sweep was cut off. */
  observed_at_least?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
  error?: never;
  reason?: never;
}

export interface AgentMemoryIndexUnavailable {
  root?: string | null;
  total?: null;
  observed_at_least?: null;
  truncated?: null;
  entries?: null;
  error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';
  reason: string;
}

/** `error` is the discriminant: a measurement failure never reverts to `null`. */
export type AgentMemoryIndex = AgentMemoryIndexAvailable | AgentMemoryIndexUnavailable;

export interface AgentDirective {
  /**
   * false = this gateway does not publish the endpoint (404).
   * true = it does publish, but the files may be empty if they could not be read.
   */
  publicado: boolean;
  /** Whether the read was performed against the container with measured environment facts. */
  medido?: boolean;
  /** Why the read could not be performed, when `publicado` is false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  /** Codex applies precedence; Claude only exposes its load order. */
  manual_order?: 'codex_precedence' | 'claude_load_order' | 'workspace_only' | null;
  /** This path measures standard manuals; it does not claim to cover all the harness's context sources. */
  context_coverage?: 'standard_manuals' | null;
  context_limitations?: string[] | null;
  memory?: AgentMemoryIndex | null;
}
