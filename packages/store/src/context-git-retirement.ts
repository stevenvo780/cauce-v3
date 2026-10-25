import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextRetirementReceiptSchema,
  type ContextRetirementPreview, type ContextRetirementReceipt } from '@cauce/protocol';
import { ContextGitBroker } from './context-git.js';
import { StoreError } from './repository/errors.js';

const MAIN = 'refs/heads/main';
const OID = /^[a-f0-9]{40,64}$/u;
interface TreeEntry { mode: string; oid: string; bytes: number; path: string }
type BoundReceipt = Omit<ContextRetirementReceipt, 'commit' | 'pushed' | 'idempotent_replay'>;

export function requireTestContextCompany(company: string): void {
  if (!/^(?:zz-canary-[a-z0-9_-]+|e2e(?:-[a-z0-9_-]+)?|lab(?:-[a-z0-9_-]+)?|v4_verificacion)$/u.test(company)
      || company === 'zz-canary-144') throw new StoreError('forbidden', 'only unprotected test-company context trees may be retired');
}

/** Changes only Git tree entries; file bodies never leave the object database. */
export class ContextGitRetirementBroker extends ContextGitBroker {
  async remoteHead(): Promise<string> {
    await this.root();
    const output = await this.git(['ls-remote', '--refs', 'origin', MAIN]);
    if (output === '') return '';
    const entries = output.split('\n');
    if (entries.length !== 1) throw new StoreError('conflict', 'context remote has ambiguous main');
    const [oid, ref] = entries[0]?.split(/\s+/u) ?? [];
    if (oid === undefined || !OID.test(oid) || ref !== MAIN) throw new StoreError('conflict', 'context remote main is invalid');
    return oid;
  }

  private async companyTree(head: string, company: string): Promise<string | undefined> {
    const raw = await this.git(['ls-tree', '-d', '-z', head, '--', `companies/${company}`]);
    if (raw === '') return undefined;
    const match = /^040000 tree ([a-f0-9]{40,64})\t([^\0]+)\0$/u.exec(raw);
    if (match?.[2] !== `companies/${company}`) throw new StoreError('conflict', 'context company tree is ambiguous');
    return match[1];
  }

  private async entries(head: string, company: string): Promise<TreeEntry[]> {
    const prefix = `companies/${company}/`;
    const raw = await this.git(['ls-tree', '-r', '-l', '-z', '--full-tree', head, '--', `companies/${company}`]);
    return raw.split('\0').filter(Boolean).map(line => {
      const match = /^(100644) blob ([a-f0-9]{40,64})\s+([0-9]+)\t(.+)$/u.exec(line);
      if (!match || !match[4]?.startsWith(prefix) || /[\p{Cc}]/u.test(match[4])) {
        throw new StoreError('conflict', 'context tree contains unsupported entries');
      }
      return { mode: match[1] ?? '', oid: match[2] ?? '', bytes: Number(match[3]), path: match[4] };
    });
  }

  async lookup(operation: string): Promise<ContextRetirementReceipt | undefined> {
    const marker = `Cauce-Context-Retirement: ${operation}`;
    const matches = await this.git(['log', MAIN, '--fixed-strings', `--grep=${marker}`, '--format=%H']);
    if (matches === '') return undefined;
    const commits = matches.split('\n');
    if (commits.length !== 1 || !OID.test(commits[0] ?? '')) throw new StoreError('conflict', 'context operation identity is ambiguous');
    const commit = commits[0] ?? '';
    const message = await this.git(['show', '-s', '--format=%B', commit]);
    const position = message.indexOf(marker + '\n');
    if (position < 0) throw new StoreError('conflict', 'context operation marker is invalid');
    const metadata: unknown = JSON.parse(message.slice(position + marker.length).trim());
    const receipt = ContextRetirementReceiptSchema.parse({ ...(metadata as BoundReceipt), commit, pushed: false, idempotent_replay: true });
    if (receipt.operation_id !== operation) throw new StoreError('conflict', 'context operation marker changed identity');
    requireTestContextCompany(receipt.company_id);
    const parents = (await this.git(['rev-list', '--parents', '-n', '1', commit])).split(' ');
    const before = await this.companyTree(receipt.before_head, receipt.company_id);
    const after = await this.companyTree(commit, receipt.company_id);
    if (parents.length !== 2 || parents[0] !== commit || parents[1] !== receipt.before_head
        || (receipt.action === 'retire' ? before !== receipt.tree_oid || after !== undefined
          : before !== undefined || after !== receipt.tree_oid)) {
      throw new StoreError('conflict', 'context operation metadata differs from its committed tree effect');
    }
    const source = receipt.action === 'retire' ? receipt.before_head : commit;
    const entries = await this.entries(source, receipt.company_id);
    if (entries.length !== receipt.entry_count || entries.reduce((total, entry) => total + entry.bytes, 0) !== receipt.logical_bytes) {
      throw new StoreError('conflict', 'context operation sizes differ from its committed tree');
    }
    return receipt;
  }

  async snapshot(company: string, action: 'retire' | 'restore', retirement?: string) {
    requireTestContextCompany(company);
    await this.root();
    const head = await this.localMain();
    if (!OID.test(head)) throw new StoreError('conflict', 'context main is unavailable');
    let source = head;
    const present = await this.companyTree(head, company);
    if (action === 'restore') {
      if (!retirement || !OID.test(retirement) || !await this.isAncestor(retirement, head)) {
        throw new StoreError('conflict', 'retirement commit is not in context history');
      }
      const body = await this.git(['show', '-s', '--format=%B', retirement]);
      const marker = /Cauce-Context-Retirement: ([a-f0-9-]+)\n/iu.exec(body);
      const saved = marker?.[1] ? await this.lookup(marker[1]) : undefined;
      if (saved?.commit !== retirement || saved.company_id !== company || saved.action !== 'retire') {
        throw new StoreError('conflict', 'restore requires the exact company retirement receipt');
      }
      if (present !== undefined) throw new StoreError('conflict', 'context company tree already exists');
      source = saved.before_head;
    } else if (present === undefined) throw new StoreError('not_found', 'context company tree is absent');
    const tree = await this.companyTree(source, company);
    if (tree === undefined) throw new StoreError('conflict', 'context source tree is absent');
    const entries = await this.entries(source, company);
    return { head, tree_oid: tree, entry_count: entries.length,
      logical_bytes: entries.reduce((total, entry) => total + entry.bytes, 0), source };
  }

  async change(preview: ContextRetirementPreview, operation: string): Promise<ContextRetirementReceipt> {
    const snapshot = await this.snapshot(preview.company_id, preview.action, preview.retirement_commit);
    if (snapshot.head !== preview.head || snapshot.tree_oid !== preview.tree_oid) {
      throw new StoreError('conflict', 'context tree changed before its commit');
    }
    const temporary = await mkdtemp(join(this.repositoryRoot, '.git', 'context-retirement-'));
    const index = join(temporary, 'index');
    try {
      await this.git(['read-tree', snapshot.head], { index });
      await this.clearFolder(`companies/${preview.company_id}`, index);
      if (preview.action === 'restore') {
        const entries = await this.entries(snapshot.source, preview.company_id);
        await this.git(['update-index', '-z', '--index-info'], { index,
          input: entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('') });
      }
      const tree = await this.git(['write-tree'], { index });
      const bound: BoundReceipt = { version: 1, operation_id: operation, company_id: preview.company_id,
        action: preview.action, before_head: preview.head, tree_oid: preview.tree_oid, preview_sha256: preview.preview_sha256,
        entry_count: preview.entry_count, logical_bytes: preview.logical_bytes,
        ...(preview.retirement_commit ? { retirement_commit: preview.retirement_commit } : {}) };
      const commit = await this.git(['commit-tree', tree, '-p', snapshot.head], {
        input: `Context tree ${preview.action}\n\nCauce-Context-Retirement: ${operation}\n${JSON.stringify(bound)}\n` });
      await this.git(['update-ref', MAIN, commit, snapshot.head]);
      return ContextRetirementReceiptSchema.parse({ ...bound, commit, pushed: false, idempotent_replay: false });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async publish(receipt: ContextRetirementReceipt, expectedRemote: string): Promise<ContextRetirementReceipt> {
    const current = await this.remoteHead();
    if (current !== '' && await this.isAncestor(receipt.commit, current)) {
      const tree = await this.companyTree(current, receipt.company_id);
      if (receipt.action === 'retire' ? tree !== undefined : tree !== receipt.tree_oid) {
        throw new StoreError('conflict', 'published context company tree changed');
      }
      return { ...receipt, pushed: true };
    }
    if (current !== expectedRemote) throw new StoreError('conflict', 'context remote changed; local retirement remains in history');
    await this.git(['push', '--porcelain', 'origin', `${receipt.commit}:${MAIN}`]);
    const remote = await this.remoteHead();
    if (remote === '' || !await this.isAncestor(receipt.commit, remote)) throw new StoreError('conflict', 'context retirement push is unverified');
    const tree = await this.companyTree(remote, receipt.company_id);
    if (receipt.action === 'retire' ? tree !== undefined : tree !== receipt.tree_oid) {
      throw new StoreError('conflict', 'published context company tree changed');
    }
    return { ...receipt, pushed: true };
  }

  async observe(receipt: ContextRetirementReceipt): Promise<ContextRetirementReceipt> {
    const remote = await this.remoteHead();
    if (remote === '' || !await this.isAncestor(receipt.commit, remote)) return { ...receipt, pushed: false };
    const tree = await this.companyTree(remote, receipt.company_id);
    if (receipt.action === 'retire' ? tree !== undefined : tree !== receipt.tree_oid) {
      throw new StoreError('conflict', 'published context company tree changed');
    }
    return { ...receipt, pushed: true };
  }
}
