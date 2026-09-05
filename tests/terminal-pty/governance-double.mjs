// Governance double for the PTY wire contract v1: READ (file and memory index) / WRITE /
// WRITE_BATCH over a private mkdtemp, with the same preconditions, error codes and reason strings
// the Python agent answers (ops/pty-agent/cauce_pty_agent/governance_read.py and
// governance_write.py). The read and write path validators are deliberately NOT the same function:
// the agent's write shape check collapses too-long, null-byte and relative paths into one reason,
// and the batch collapses size, chunk count and their disagreement into one `too_large`.
// It never opens a path outside the tree it created, and `dispose()` removes that tree.
// Used by tests/terminal-pty/fake-pty-agent.mjs and by the golden vector walk in
// tests/terminal-pty/vectors.test.ts.
//
// Not modelled, and therefore not proven by any vector: the four-transaction ceiling
// (`max_write_transactions`), the 5000-entry scan cap and the index byte budget
// (`dir_scan_cap`, `read_index_budget`). Their vectors.json values rest on the Python walk in
// ops/pty-agent/tests/test_vectors_contract.py, not on this double.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_FRAME_PAYLOAD, SESSION_ID_BYTES, TAG } from './protocol.mjs';

const MAX_DATA_BYTES = MAX_FRAME_PAYLOAD - SESSION_ID_BYTES;

export const GOVERNANCE = {
  max_read_path: 4096,
  max_document_bytes: 256 * 1024,
  max_write_transactions: 4,
  max_write_batch_files: 7,
  max_dir_entries: 200,
  max_dir_depth: 3,
  dir_scan_cap: 5000,
  read_index_budget: 48 * 1024,
  never_serve_basenames: new Set([
    '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
    'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
  ]),
  never_serve_suffixes: ['.pem', '.key', '.p12', '.pfx'],
  profiles: {
    claude: { root: ['.claude'], names: ['CLAUDE.md'], memory: 'projects' },
    codex: { root: ['.codex'], names: ['AGENTS.md'], memory: 'memories' },
    openclaw: {
      root: ['.openclaw', 'workspace'],
      names: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md'],
      memory: 'memory',
    },
  },
};

export const GOVERNANCE_FEATURES = [
  'read_governance', 'write_governance_v1', 'write_governance_batch_v1', 'read_governance_done_v1',
];

/** A document never travels in more chunks than its cap allows; the batch shares this budget. */
const MAX_CHUNKS_PER_DOCUMENT = Math.ceil(GOVERNANCE.max_document_bytes / MAX_DATA_BYTES);

const SHA256_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isCanonicalAbsolutePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.length > GOVERNANCE.max_read_path || path.includes('\0') || !path.startsWith('/')) return false;
  const segments = path.split('/');
  return !segments.includes('..') && !segments.includes('.') && !segments.slice(1).includes('');
}

function chunksOf(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_DATA_BYTES) {
    parts.push(bytes.subarray(offset, offset + MAX_DATA_BYTES));
  }
  return parts;
}

class GovernanceFailure extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'GovernanceFailure';
    this.code = code;
    this.reason = reason;
  }
}

export function createGovernanceSandbox(options = {}) {
  const harness = options.harness ?? 'claude';
  const profile = GOVERNANCE.profiles[harness];
  if (profile === undefined) throw new Error(`unknown harness ${harness}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cauce-fake-pty-')));
  const root = join(home, ...profile.root);
  const memoryRoot = join(root, profile.memory);
  mkdirSync(memoryRoot, { recursive: true });
  const governed = new Set(profile.names.map((name) => join(root, name)));
  const writes = new Map();
  const batches = new Map();

  const pathOf = (name) => join(root, name);
  const shaOf = (path) => {
    try {
      return sha256Hex(readFileSync(path));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  /** Read shape: the agent names each syntactic defect separately (`_validate_read_path`). */
  function validateReadPath(path) {
    if (typeof path !== 'string' || path.length === 0) return ['invalid_path', 'path is required'];
    if (path.length > GOVERNANCE.max_read_path) return ['invalid_path', 'path is too long'];
    if (path.includes('\0')) return ['invalid_path', 'path carries a null byte'];
    if (!path.startsWith('/')) return ['invalid_path', 'path is not absolute'];
    if (!isCanonicalAbsolutePath(path)) return ['invalid_path', 'path is not canonical'];
    return governedVerdict(path, 'is not a governance document');
  }

  /** Write shape: the agent collapses the first three into one reason (`_validate_write_shape`). */
  function validateWritePath(path) {
    if (typeof path !== 'string' || path.length === 0) return ['invalid_path', 'path is required'];
    if (path.length > GOVERNANCE.max_read_path || path.includes('\0') || !path.startsWith('/')) {
      return ['invalid_path', 'path is not a bounded absolute path'];
    }
    if (!isCanonicalAbsolutePath(path)) return ['invalid_path', 'path is not canonical'];
    return governedVerdict(path, 'is not a governance document');
  }

  function governedVerdict(path, governedMessage) {
    const base = path.split('/').pop();
    const normalised = base.toLowerCase();
    if (GOVERNANCE.never_serve_basenames.has(normalised)) {
      return ['permission_denied', `${base} is never served`];
    }
    if (GOVERNANCE.never_serve_suffixes.some((suffix) => normalised.endsWith(suffix))) {
      return ['permission_denied', 'looks like credential material'];
    }
    if (!governed.has(path)) return ['permission_denied', `${base} ${governedMessage}`];
    if (!path.startsWith(`${home}/`)) return ['permission_denied', 'path is outside the agent home'];
    return null;
  }

  function readError(requestId, code, reason) {
    return [{ tag: TAG.READ_ERR, json: { request_id: requestId, error: code, reason } }];
  }

  function handleRead(request) {
    const requestId = request.request_id;
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      throw new GovernanceFailure('protocol_error', 'READ carries an invalid request id');
    }
    if (request.kind !== 'file' && request.kind !== 'dir') {
      return readError(requestId, 'invalid_path', 'kind must be file or dir');
    }
    if (request.kind === 'dir') {
      if (request.path !== memoryRoot) {
        return readError(requestId, 'permission_denied', 'path is not the measured memory root');
      }
      return memoryIndex(requestId);
    }
    const verdict = validateReadPath(request.path);
    if (verdict !== null) return readError(requestId, verdict[0], verdict[1]);
    let info;
    try {
      info = lstatSync(request.path);
    } catch (error) {
      if (error.code === 'ENOENT') return readError(requestId, 'not_found', 'no such file');
      return readError(requestId, 'unknown', 'stat failed');
    }
    if (!info.isFile()) return readError(requestId, 'invalid_path', 'not a regular file');
    if (realpathSync(request.path) !== request.path) {
      return readError(requestId, 'symlink_detected', 'path resolves somewhere else');
    }
    const raw = readFileSync(request.path);
    const served = raw.subarray(0, GOVERNANCE.max_document_bytes);
    const parts = chunksOf(served);
    const outputs = [{
      tag: TAG.READ_OK,
      json: {
        request_id: requestId,
        kind: 'file',
        path: request.path,
        bytes: raw.length,
        truncated: raw.length > GOVERNANCE.max_document_bytes,
        modified_at: `${new Date(info.mtimeMs).toISOString().slice(0, 19)}Z`,
        sha: sha256Hex(raw),
        chunks: parts.length,
      },
    }];
    for (const part of parts) outputs.push({ tag: TAG.READ_DATA, request_id: requestId, data: part });
    outputs.push({ tag: TAG.READ_DONE, json: { request_id: requestId } });
    return outputs;
  }

  /**
   * Memory index: METADATA travels, never content. Mirrors `_send_memory_index`: a credential
   * name is not even listed, a symlink is not named at all, the walk stops below
   * `max_dir_depth`, and the reply is cut by `max_dir_entries` and by the byte budget so the
   * index always fits in one frame.
   */
  function memoryIndex(requestId) {
    const found = [];
    let capped = false;
    let scanned = 0;
    const walk = (directory, current, depth) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return; // An unreadable subdirectory is skipped, it does not invalidate the index.
      }
      for (const entry of entries) {
        if (scanned >= GOVERNANCE.dir_scan_cap) {
          capped = true;
          return;
        }
        scanned += 1;
        const normalised = entry.name.toLowerCase();
        if (GOVERNANCE.never_serve_basenames.has(normalised)) continue;
        if (GOVERNANCE.never_serve_suffixes.some((suffix) => normalised.endsWith(suffix))) continue;
        const logical = `${current}/${entry.name}`;
        if (Buffer.byteLength(logical, 'utf8') > GOVERNANCE.max_read_path) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth + 1 < GOVERNANCE.max_dir_depth) {
            walk(join(directory, entry.name), logical, depth + 1);
            if (capped) return;
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const info = lstatSync(join(directory, entry.name));
        found.push({ path: logical, bytes: info.size, mtime: info.mtimeMs });
      }
    };
    walk(memoryRoot, memoryRoot, 0);
    found.sort((left, right) => right.mtime - left.mtime);
    const rows = [];
    let budget = GOVERNANCE.read_index_budget;
    for (const item of found.slice(0, GOVERNANCE.max_dir_entries)) {
      const cost = Buffer.byteLength(item.path, 'utf8') + 80;
      if (cost > budget) break;
      budget -= cost;
      rows.push({
        path: item.path,
        bytes: item.bytes,
        modified_at: `${new Date(item.mtime).toISOString().slice(0, 19)}Z`,
      });
    }
    return [
      {
        tag: TAG.READ_OK,
        json: {
          request_id: requestId,
          kind: 'dir',
          path: memoryRoot,
          total: capped ? null : found.length,
          observed_at_least: found.length,
          truncated: capped || rows.length < found.length,
          entries: rows,
        },
      },
      { tag: TAG.READ_DONE, json: { request_id: requestId } },
    ];
  }

  function writeError(requestId, code, reason) {
    return [{ tag: TAG.WRITE_ERR, json: { request_id: requestId, error: code, reason } }];
  }

  function checkWriteEntry(entry) {
    const verdict = validateWritePath(entry.path);
    if (verdict !== null) return verdict;
    if (entry.operation !== 'replace' && entry.operation !== 'create') {
      return ['invalid_path', 'operation must be replace or create'];
    }
    if (entry.operation === 'replace') {
      if (typeof entry.expected_sha !== 'string' || !SHA256_RE.test(entry.expected_sha)) {
        return ['invalid_path', 'replace requires a lowercase SHA-256 precondition'];
      }
    } else if (entry.expected_sha !== undefined && entry.expected_sha !== null) {
      return ['invalid_path', 'create must use the absent precondition'];
    }
    if (typeof entry.content_sha !== 'string' || !SHA256_RE.test(entry.content_sha)) {
      return ['invalid_path', 'content_sha must be a lowercase SHA-256'];
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > GOVERNANCE.max_document_bytes) {
      return ['too_large', 'content size is outside the governance limit'];
    }
    if (!Number.isInteger(entry.chunks) || entry.chunks < 0 || entry.chunks > MAX_CHUNKS_PER_DOCUMENT
      || (entry.bytes === 0) !== (entry.chunks === 0)) {
      return ['invalid_path', 'chunk count does not match the content size'];
    }
    return null;
  }

  /**
   * A batch entry is judged with the agent's OWN order and vocabulary, which is not the
   * single-write one: the size, the chunk count and their disagreement collapse into a single
   * `too_large`, and a negative number is named before the mode is even looked at.
   */
  function checkBatchWriteEntry(entry) {
    if (entry.operation !== 'replace' && entry.operation !== 'create') {
      return ['invalid_path', 'write operation must be replace or create'];
    }
    if (entry.operation === 'replace') {
      if (typeof entry.expected_sha !== 'string' || !SHA256_RE.test(entry.expected_sha)) {
        return ['invalid_path', 'replace requires a SHA-256 precondition'];
      }
    } else if (entry.expected_sha !== undefined && entry.expected_sha !== null) {
      return ['invalid_path', 'create must use the absent precondition'];
    }
    if (typeof entry.content_sha !== 'string' || !SHA256_RE.test(entry.content_sha)) {
      return ['invalid_path', 'write content_sha must be a SHA-256'];
    }
    if (entry.bytes > GOVERNANCE.max_document_bytes || entry.chunks > MAX_CHUNKS_PER_DOCUMENT
      || (entry.bytes === 0) !== (entry.chunks === 0)) {
      return ['too_large', 'batch entry exceeds the governance limit'];
    }
    return null;
  }

  function handleWrite(request) {
    const requestId = request.request_id;
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      throw new GovernanceFailure('protocol_error', 'WRITE carries an invalid request id');
    }
    if (writes.has(requestId)) {
      writes.delete(requestId);
      return writeError(requestId, 'conflict', 'duplicate write request id');
    }
    if (writes.size >= GOVERNANCE.max_write_transactions) {
      return writeError(requestId, 'unavailable', 'too many governance writes in flight');
    }
    const verdict = checkWriteEntry(request);
    if (verdict !== null) return writeError(requestId, verdict[0], verdict[1]);
    const pending = { ...request, received: [], received_bytes: 0 };
    writes.set(requestId, pending);
    return request.chunks === 0 ? finishWrite(pending) : [];
  }

  function handleWriteData(requestId, data) {
    const pending = writes.get(requestId);
    if (pending === undefined) return [];
    pending.received.push(Buffer.from(data));
    pending.received_bytes += data.length;
    if (pending.received.length > pending.chunks || pending.received_bytes > pending.bytes) {
      writes.delete(requestId);
      return writeError(requestId, 'too_large', 'write data exceeds the announced content');
    }
    return pending.received.length === pending.chunks ? finishWrite(pending) : [];
  }

  function finishWrite(pending) {
    writes.delete(pending.request_id);
    const content = Buffer.concat(pending.received);
    if (content.length !== pending.bytes || sha256Hex(content) !== pending.content_sha) {
      return writeError(pending.request_id, 'conflict', 'content does not match its announced digest');
    }
    if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content)) {
      return writeError(pending.request_id, 'invalid_path', 'governance content must be UTF-8 text');
    }
    const acknowledge = () => [{
      tag: TAG.WRITE_OK,
      json: {
        request_id: pending.request_id,
        path: pending.path,
        operation: pending.operation,
        sha: pending.content_sha,
        bytes: pending.bytes,
      },
    }];
    const current = shaOf(pending.path);
    if (current === pending.content_sha) return acknowledge();
    if (pending.operation === 'create' && current !== null) {
      return writeError(pending.request_id, 'conflict', 'the file exists; create precondition failed');
    }
    if (pending.operation === 'replace') {
      if (current === null) {
        return writeError(pending.request_id, 'not_found', 'the file vanished before replacement');
      }
      if (current !== pending.expected_sha) {
        return writeError(pending.request_id, 'conflict', 'the file changed; SHA-256 precondition failed');
      }
    }
    commitBytes(pending.path, content, `.cauce-governance-${pending.request_id}.tmp`);
    return acknowledge();
  }

  function commitBytes(path, content, temporaryName) {
    const directory = path.slice(0, path.lastIndexOf('/'));
    const temporary = join(directory, temporaryName);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  }

  function batchError(requestId, code, reason) {
    return [{ tag: TAG.WRITE_BATCH_ERR, json: { request_id: requestId, error: code, reason } }];
  }

  function handleWriteBatch(request) {
    const requestId = request.request_id;
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      throw new GovernanceFailure('protocol_error', 'WRITE_BATCH carries an invalid request id');
    }
    if (batches.has(requestId) || writes.has(requestId)) {
      batches.delete(requestId);
      return batchError(requestId, 'conflict', 'duplicate write batch request id');
    }
    if (writes.size + batches.size >= GOVERNANCE.max_write_transactions) {
      return batchError(requestId, 'unavailable', 'too many governance writes in flight');
    }
    const raw = request.entries;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > GOVERNANCE.max_write_batch_files) {
      return batchError(requestId, 'too_large', 'batch must contain one to seven files');
    }
    const entries = [];
    const seen = new Set();
    let totalBytes = 0;
    let totalChunks = 0;
    const maxBatchChunks = MAX_CHUNKS_PER_DOCUMENT + raw.length - 1;
    for (const item of raw) {
      if (item === null || typeof item !== 'object') {
        return batchError(requestId, 'invalid_path', 'batch entry must be an object');
      }
      const shape = validateWritePath(item.path);
      if (shape !== null) return batchError(requestId, shape[0], shape[1]);
      if (seen.has(item.path)) return batchError(requestId, 'conflict', 'batch contains duplicate paths');
      seen.add(item.path);
      if (!Number.isInteger(item.bytes) || !Number.isInteger(item.chunks)
        || item.bytes < 0 || item.chunks < 0) {
        return batchError(requestId, 'invalid_path', 'batch sizes must be non-negative integers');
      }
      if (item.mode === 'write') {
        const verdict = checkBatchWriteEntry(item);
        if (verdict !== null) return batchError(requestId, verdict[0], verdict[1]);
      } else if (item.mode === 'verify') {
        if (item.operation === 'present') {
          if (typeof item.expected_sha !== 'string' || !SHA256_RE.test(item.expected_sha)) {
            return batchError(requestId, 'invalid_path', 'verify present requires a SHA-256');
          }
        } else if (item.operation === 'absent') {
          if (item.expected_sha !== undefined && item.expected_sha !== null) {
            return batchError(requestId, 'invalid_path', 'verify absent cannot carry a SHA-256');
          }
        } else {
          return batchError(requestId, 'invalid_path', 'verify operation must be present or absent');
        }
        if (item.content_sha !== undefined || item.bytes !== 0 || item.chunks !== 0) {
          return batchError(requestId, 'invalid_path', 'verify entries cannot carry content');
        }
      } else {
        return batchError(requestId, 'invalid_path', 'batch mode must be write or verify');
      }
      totalBytes += item.bytes;
      totalChunks += item.chunks;
      if (totalBytes > GOVERNANCE.max_document_bytes || totalChunks > maxBatchChunks) {
        return batchError(requestId, 'too_large', 'batch exceeds the total governance limit');
      }
      entries.push({ ...item, received: [], received_bytes: 0 });
    }
    const pending = { request_id: requestId, entries };
    batches.set(requestId, pending);
    return batchComplete(pending) ? finishWriteBatch(pending) : [];
  }

  function batchComplete(pending) {
    return pending.entries.every((entry) => entry.received.length === entry.chunks);
  }

  function handleWriteBatchData(requestId, data) {
    const pending = batches.get(requestId);
    if (pending === undefined) return [];
    const entry = pending.entries.find((candidate) => candidate.received.length < candidate.chunks);
    if (entry === undefined) {
      batches.delete(requestId);
      return batchError(requestId, 'conflict', 'batch received unannounced data');
    }
    entry.received.push(Buffer.from(data));
    entry.received_bytes += data.length;
    if (entry.received.length > entry.chunks || entry.received_bytes > entry.bytes) {
      batches.delete(requestId);
      return batchError(requestId, 'too_large', 'batch data exceeds its announced entry');
    }
    return batchComplete(pending) ? finishWriteBatch(pending) : [];
  }

  function finishWriteBatch(pending) {
    batches.delete(pending.request_id);
    for (const entry of pending.entries) {
      if (entry.mode !== 'write') continue;
      const content = Buffer.concat(entry.received);
      if (content.length !== entry.bytes || sha256Hex(content) !== entry.content_sha) {
        return batchError(pending.request_id, 'conflict', 'batch content does not match its announced digest');
      }
      if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content)) {
        return batchError(pending.request_id, 'invalid_path', 'governance content must be UTF-8 text');
      }
      entry.content = content;
    }
    try {
      return [{
        tag: TAG.WRITE_BATCH_OK,
        json: { request_id: pending.request_id, files: applyBatch(pending) },
      }];
    } catch (error) {
      if (error instanceof GovernanceFailure) {
        return batchError(pending.request_id, error.code, error.reason);
      }
      return batchError(pending.request_id, 'unknown', `batch write failed: ${error.code ?? 'OSError'}`);
    }
  }

  function applyBatch(pending) {
    const plans = [];
    try {
      pending.entries.forEach((entry, index) => {
        const base = entry.path.split('/').pop();
        const current = shaOf(entry.path);
        const plan = { entry, index, base, current, temporary: null, backup: null, committed: false };
        plans.push(plan);
        if (entry.mode === 'verify') {
          if (entry.operation === 'present') {
            if (current === null) throw new GovernanceFailure('not_found', 'a required file is absent');
            if (current !== entry.expected_sha) {
              throw new GovernanceFailure('conflict', `${base} changed; SHA-256 precondition failed`);
            }
            plan.ack = 'unchanged';
          } else {
            if (current !== null) throw new GovernanceFailure('conflict', 'an absent precondition failed');
            plan.ack = 'absent';
          }
          return;
        }
        if (current === entry.content_sha) {
          plan.ack = 'unchanged';
          return;
        }
        if (entry.operation === 'create') {
          if (current !== null) throw new GovernanceFailure('conflict', 'an absent precondition failed');
        } else {
          if (current === null) throw new GovernanceFailure('not_found', 'a required file is absent');
          if (current !== entry.expected_sha) {
            throw new GovernanceFailure('conflict', `${base} changed; SHA-256 precondition failed`);
          }
        }
        plan.ack = entry.operation;
      });

      for (const plan of plans) {
        if (plan.entry.mode !== 'write' || plan.ack === 'unchanged') continue;
        const directory = plan.entry.path.slice(0, plan.entry.path.lastIndexOf('/'));
        plan.temporary = join(directory, `.cauce-profile-${pending.request_id}-${plan.index}.tmp`);
        const descriptor = openSync(plan.temporary, 'wx', 0o600);
        try {
          writeSync(descriptor, plan.entry.content);
        } finally {
          closeSync(descriptor);
        }
        if (plan.ack === 'replace') {
          plan.backup = join(directory, `.cauce-profile-${pending.request_id}-${plan.index}.bak`);
          linkSync(plan.entry.path, plan.backup);
        }
      }

      try {
        for (const plan of plans) {
          if (plan.entry.mode !== 'write' || plan.ack === 'unchanged') continue;
          if (plan.ack === 'create') {
            linkSync(plan.temporary, plan.entry.path);
            unlinkSync(plan.temporary);
          } else {
            renameSync(plan.temporary, plan.entry.path);
          }
          plan.temporary = null;
          plan.committed = true;
        }
      } catch (error) {
        for (const plan of [...plans].reverse()) {
          if (!plan.committed) continue;
          if (plan.ack === 'create') {
            unlinkSync(plan.entry.path);
          } else {
            renameSync(plan.backup, plan.entry.path);
            plan.backup = null;
          }
        }
        throw error;
      }

      return plans.map((plan) => ({
        path: plan.entry.path,
        operation: plan.ack,
        sha: plan.ack === 'absent' ? null : (plan.entry.mode === 'write' ? plan.entry.content_sha : plan.entry.expected_sha),
        bytes: plan.ack === 'absent' ? 0 : (plan.entry.mode === 'write' ? plan.entry.bytes : readFileSync(plan.entry.path).length),
      }));
    } finally {
      for (const plan of plans) {
        for (const leftover of [plan.temporary, plan.backup]) {
          if (leftover === null || leftover === undefined) continue;
          try {
            unlinkSync(leftover);
          } catch { /* already gone */ }
        }
      }
    }
  }

  return {
    harness,
    home,
    root,
    memory_root: memoryRoot,
    path: pathOf,
    sha: shaOf,
    seed(files) {
      for (const file of files ?? []) {
        const bytes = file.fill !== undefined
          ? Buffer.alloc(file.fill.count, file.fill.byte)
          : Buffer.from(file.text ?? '', 'utf8');
        const descriptor = openSync(pathOf(file.name), 'w', 0o600);
        try {
          writeSync(descriptor, bytes);
        } finally {
          closeSync(descriptor);
        }
      }
    },
    seedMemory(files) {
      for (const file of files ?? []) {
        const path = join(memoryRoot, file.name);
        mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        const descriptor = openSync(path, 'w', 0o600);
        try {
          writeSync(descriptor, Buffer.from(file.text ?? '', 'utf8'));
        } finally {
          closeSync(descriptor);
        }
      }
    },
    read: handleRead,
    write: handleWrite,
    writeData: handleWriteData,
    writeCancel: (requestId) => { writes.delete(requestId); return []; },
    writeBatch: handleWriteBatch,
    writeBatchData: handleWriteBatchData,
    writeBatchCancel: (requestId) => { batches.delete(requestId); return []; },
    runWrite(request, parts) {
      const outputs = handleWrite(request);
      for (const part of parts ?? []) outputs.push(...handleWriteData(request.request_id, part));
      return outputs;
    },
    runWriteBatch(request, parts) {
      const outputs = handleWriteBatch(request);
      for (const part of parts ?? []) outputs.push(...handleWriteBatchData(request.request_id, part));
      return outputs;
    },
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
