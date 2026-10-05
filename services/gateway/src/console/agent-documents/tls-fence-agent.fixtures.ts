import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { AgentLeg, createAgentTlsServer } from '../../../../terminal-relay/src/agent-leg.js';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeJsonFrame, FrameDecoder, FRAME_TAGS,
} from '../../../../terminal-relay/src/framing.js';

interface PendingWrite {
  readonly id: string;
  readonly path: string;
  readonly operation: string;
  readonly expectedSha: string;
  readonly contentSha: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly data: Buffer[];
  readonly request: Record<string, unknown>;
}

const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

export async function tlsFenceAgentFixture(options: {
  cert: Buffer; key: Buffer; directory: string; disk: string; path: string;
}) {
  const material = { cert: options.cert, key: options.key, ca: options.cert };
  const registryFile = join(options.directory, 'registry.json');
  writeFileSync(registryFile, JSON.stringify({ version: 1, agents: [{
    fingerprint_sha256: new X509Certificate(options.cert).fingerprint256,
    tenant_id: 'Miguel', alias: 'kant', expires_at: new Date(Date.now() + 60_000).toISOString(),
  }] }));
  const listener = createAgentTlsServer(material);
  const leg = new AgentLeg({ server: listener, registryFile });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const sockets: TLSSocket[] = [];
  let writes = 0;
  let reads = 0;
  const writerInstanceId = randomUUID();
  const receipts = new Map<string, Record<string, unknown>>();

  async function reconnect(generation = 'measured-one', containerId = 'container-one'): Promise<void> {
    const socket = connect({ ...material, host: '127.0.0.1', port: (listener.address() as AddressInfo).port });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const decoder = new FrameDecoder();
      let pending: PendingWrite | undefined;
      socket.on('error', reject);
      socket.on('secureConnect', () => socket.write(encodeJsonFrame(FRAME_TAGS.AGENT_HELLO, {
        v: 1, tenant_id: 'Miguel', alias: 'kant', generation, container_id: containerId,
        image_id: 'isolated-image', runtime_user: 'dev', runtime_uid: 1000,
        harness: 'claude', home: '/home/dev', runtime_facts_observed: true,
        agent_version: 'isolated-fixture', modes: ['shell', 'harness'],
        writer_instance_id: writerInstanceId,
        features: ['read_governance', 'write_governance_v1', 'write_quiescence_v1'],
      })));
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.tag === FRAME_TAGS.HELLO_ACK) {
            const ack = decodeJsonFrame(frame.payload);
            if (ack.ok === true) resolve(); else reject(new Error('HELLO rechazado'));
          } else if (frame.tag === FRAME_TAGS.WRITE_STATUS) {
            const request = decodeJsonFrame(frame.payload);
            const stored = receipts.get(String(request.operation_id));
            socket.write(encodeJsonFrame(FRAME_TAGS.WRITE_STATUS_OK, stored ?? {
              operation_id: request.operation_id, operation_generation: request.operation_generation,
              request_id: request.request_id, runtime_generation: request.runtime_generation,
              writer_instance_id: writerInstanceId, tenant_id: 'Miguel', alias: 'kant', container_id: containerId,
              state: 'unknown', files: [],
            }));
          } else if (frame.tag === FRAME_TAGS.READ) {
            reads += 1;
            const request = decodeJsonFrame(frame.payload);
            const id = String(request.request_id);
            const content = readFileSync(options.disk);
            socket.write(encodeJsonFrame(FRAME_TAGS.READ_OK, {
              request_id: id, kind: 'file', path: request.path, bytes: content.length,
              truncated: false, modified_at: '2026-09-01T00:00:00Z', sha: sha(content), chunks: 1,
            }));
            socket.write(encodeDataFrame(FRAME_TAGS.READ_DATA, id, content));
          } else if (frame.tag === FRAME_TAGS.WRITE) {
            writes += 1;
            const request = decodeJsonFrame(frame.payload);
            pending = {
              request, id: String(request.request_id), path: String(request.path), operation: String(request.operation),
              expectedSha: String(request.expected_sha), contentSha: String(request.content_sha),
              bytes: Number(request.bytes), chunks: Number(request.chunks), data: [],
            };
          } else if (frame.tag === FRAME_TAGS.WRITE_DATA) {
            const data = decodeDataFrame(frame.payload);
            if (pending?.id !== data.sessionId) throw new Error('WRITE_DATA sin correlación');
            pending.data.push(data.data);
            if (pending.data.length !== pending.chunks) continue;
            const content = Buffer.concat(pending.data);
            if (pending.path !== options.path || pending.operation !== 'replace'
              || pending.expectedSha !== sha(readFileSync(options.disk))
              || pending.bytes !== content.length || pending.contentSha !== sha(content)) {
              socket.write(encodeJsonFrame(FRAME_TAGS.WRITE_ERR, {
                request_id: pending.id, code: 'conflict', reason: 'CAS o bytes de fixture rechazados',
              }));
            } else {
              writeFileSync(options.disk, content);
              const receipt = {
                operation_id: pending.request.operation_id, operation_generation: pending.request.operation_generation,
                request_id: pending.id, runtime_generation: pending.request.runtime_generation,
                writer_instance_id: writerInstanceId, tenant_id: 'Miguel', alias: 'kant', container_id: containerId,
                state: 'done', files: [{ path: pending.path, sha: sha(content), bytes: content.length }],
              };
              receipts.set(String(pending.request.operation_id), receipt);
              socket.write(encodeJsonFrame(FRAME_TAGS.WRITE_OK, {
                request_id: pending.id, path: pending.path, operation: pending.operation,
                sha: sha(content), bytes: content.length, receipt,
              }));
            }
            pending = undefined;
          }
        }
      });
    });
  }

  return {
    leg, reconnect, writerInstanceId,
    get writes() { return writes; },
    get reads() { return reads; },
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await leg.close();
    },
  };
}
