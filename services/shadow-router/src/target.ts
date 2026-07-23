import { request as httpRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import type {
  ShadowDirection, ShadowTarget, ShadowTargetRegistry, ShadowTargetRequest, ShadowTargetResult
} from './types.js';

function postUnix(socketPath: string, path: string, payload: ShadowTargetRequest): Promise<ShadowTargetResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = httpRequest({
      socketPath,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': payload.target_event_id
      },
      signal: AbortSignal.timeout(15_000)
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) {
          response.destroy(new Error('shadow target response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`shadow target returned HTTP ${response.statusCode ?? 0}`));
          return;
        }
        try {
          const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
            reject(new Error('shadow target returned an invalid response'));
            return;
          }
          resolve(decoded);
        } catch {
          reject(new Error('shadow target returned malformed JSON'));
        }
      });
    });
    request.once('error', () => reject(new Error('shadow target request failed')));
    request.end(body);
  });
}

export class UnixSocketShadowTarget implements ShadowTarget {
  constructor(private readonly socketPath: string) {
    if (!isAbsolute(socketPath)) throw new Error('shadow target socket must be absolute');
  }

  preview(request: ShadowTargetRequest): Promise<ShadowTargetResult> {
    if (request.allow_human_reply || request.allow_harness) throw new Error('preview request attempted side effects');
    return postUnix(this.socketPath, '/shadow/preview', request);
  }

  deliver(request: ShadowTargetRequest): Promise<ShadowTargetResult> {
    return postUnix(this.socketPath, '/shadow/cutover', request);
  }
}

export class MapShadowTargetRegistry implements ShadowTargetRegistry {
  private readonly targets: ReadonlyMap<ShadowDirection, ShadowTarget>;

  constructor(entries: Iterable<readonly [ShadowDirection, ShadowTarget]>) {
    this.targets = new Map(entries);
  }

  forDirection(direction: ShadowDirection): ShadowTarget | undefined {
    return this.targets.get(direction);
  }
}
