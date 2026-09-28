import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface JevRequestSeen {
  readonly authorization: string | undefined;
  readonly body: { model: string; state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };
}

export interface ScriptedReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly raw?: string;
  readonly delayMs?: number;
}

type Responder = (request: JevRequestSeen, index: number) => ScriptedReply;

/**
 * A local stand-in for api.typesafe.ai: same request and answer shapes, no key and no network.
 * By default each noul answers 0.9, each choice picks its first option and each score its top level.
 */
export function defaultAnswers(questions: JevRequestSeen['body']['questions']): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
    else if (question.type === 'choice') {
      const options = Object.keys(question.criteria as Record<string, unknown>);
      answers[id] = { type: 'choice', choice: options[0], confidence: 0.95, probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.97 : 0.03 / (options.length - 1)])) };
    } else {
      const levels = (question.criteria as unknown[]).length;
      const top = String(levels - 1);
      answers[id] = { type: 'score', score: levels - 1, confidence: 0.9, legend: {}, probabilities: { [top]: 1 } };
    }
  }
  return answers;
}

export class FakeJev {
  readonly seen: JevRequestSeen[] = [];
  private responder: Responder = (request) => ({ body: { model: 'jev-1.13.0', answers: defaultAnswers(request.body.questions), usage: { input_tokens: 900, output_tokens: 40 } } });
  private server: Server | undefined;
  port = 0;

  get url(): string { return `http://127.0.0.1:${String(this.port)}/v1/systemone`; }

  respond(responder: Responder): void { this.responder = responder; }

  answers(answers: (request: JevRequestSeen) => Record<string, unknown>): void {
    this.respond((request) => ({ body: { model: 'jev-1.13.0', answers: answers(request), usage: { input_tokens: 875, output_tokens: 30 } } }));
  }

  async start(): Promise<void> {
    this.server = createServer((incoming: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const seen: JevRequestSeen = { authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JevRequestSeen['body'] };
        this.seen.push(seen);
        const reply = this.responder(seen, this.seen.length - 1);
        const send = (): void => {
          if (response.destroyed) return;
          response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', 'x-typesafe-request-id': `req_${String(this.seen.length)}`, ...(reply.headers ?? {}) });
          response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
        };
        if (reply.delayMs === undefined) send();
        else setTimeout(send, reply.delayMs);
      });
    });
    await new Promise<void>((resolve) => { this.server?.listen(0, '127.0.0.1', resolve); });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
}
