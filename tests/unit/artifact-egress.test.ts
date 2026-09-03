import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_INLINED_ARTIFACTS_PER_RESPONSE,
  MAX_INLINED_ARTIFACT_BYTES,
  inlineLocalArtifacts,
} from '../../packages/adapter-sdk/src/sdk/artifact-inliner.js';
import type { StructuredOutput } from '../../packages/adapter-sdk/src/sdk/types.js';
import {
  MAX_EGRESS_ATTACHMENT_BYTES,
  MAX_UPLOADS_PER_RELAY,
  planArtifacts,
} from '../../services/telegram-bridge/src/artifacts.js';

/** Attachment flow end to end: the adapter inlines the local path, the bridge handles egress. */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

let scratch: string | undefined;

async function pngOnDisk(name: string): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), 'cauce-egress-'));
  const path = join(scratch, name);
  await writeFile(path, PNG_BYTES);
  return path;
}

function envelope(uri: string, name: string): StructuredOutput {
  return {
    reply: 'acá va la hoja de ruta',
    messages: [],
    notify: [],
    status: 'done',
    retryable: false,
    artifacts: [{ name, uri, media_type: 'image/png' }],
  };
}

/** The envelope as it travels in the ACK: `{ result: { output } }`. */
function ack(output: StructuredOutput): Record<string, unknown> {
  return { result: { output: JSON.parse(JSON.stringify(output)) as unknown } };
}

afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe('adjuntos salientes: del disco del agente al chat', () => {
  it('los topes del adaptador son los mismos que los del puente', () => {
    // If anyone moves just one, the adapter would convert attachments that the bridge later
    // discards, and the human would receive "stayed in the agent's workspace" without explanation.
    // A bridge cap below the protocol is Telegram's physical limit binding, not drift; above it is.
    expect(MAX_INLINED_ARTIFACT_BYTES).toBeLessThanOrEqual(MAX_EGRESS_ATTACHMENT_BYTES);
    expect(MAX_INLINED_ARTIFACTS_PER_RESPONSE).toBe(MAX_UPLOADS_PER_RELAY);
  });

  it('CONTROL NEGATIVO: sin el adaptador, el puente sólo puede explicar que no viajó', async () => {
    const path = await pngOnDisk('control-negativo.png');
    const plan = planArtifacts(ack(envelope(pathToFileURL(path).href, 'hoja_ruta_domiciliario.png')));

    expect(plan.uploads).toHaveLength(0);
    expect(plan.footer).toContain('quedó en el espacio de trabajo del agente y no viajó al chat');
  });

  it('con el adaptador, el puente sube EL fichero: mismos bytes, mismo sha, y como foto', async () => {
    const path = await pngOnDisk('hoja_ruta_domiciliario.png');
    const output = await inlineLocalArtifacts(
      envelope(pathToFileURL(path).href, 'hoja_ruta_domiciliario.png'),
    );
    const plan = planArtifacts(ack(output));

    expect(plan.uploads).toHaveLength(1);
    const upload = plan.uploads[0];
    expect(upload).toBeDefined();
    if (!upload) return;
    // The effect: the bytes Telegram would receive are byte-for-byte those of the agent's file.
    expect(upload.bytes.equals(PNG_BYTES)).toBe(true);
    expect(upload.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'));
    // "An image or a document", not an anonymous file: it renders inside the chat.
    expect(upload.kind).toBe('photo');
    expect(upload.mime_type).toBe('image/png');
    expect(upload.name).toBe('hoja_ruta_domiciliario.png');
    expect(plan.footer).toBe('');
  });

  it('el turno cuyo ÚNICO producto es el fichero ya no es MISSING_FINAL_REPLY: el plan trae la subida', async () => {
    const path = await pngOnDisk('solo-fichero.png');
    const salida = await inlineLocalArtifacts({
      ...envelope(pathToFileURL(path).href, 'solo-fichero.png'), reply: ''
    });
    const plan = planArtifacts(ack(salida));

    expect(plan.uploads).toHaveLength(1);
    expect(plan.uploads[0]?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(plan.footer).toBe('');
  });

  it('lo que no cupo en el presupuesto del turno se explica como tal, no como ruta del agente', () => {
    const plan = planArtifacts(ack(envelope('cauce:not-sent', 'pesado.bin')));

    expect(plan.uploads).toHaveLength(0);
    expect(plan.footer).toContain('superó el presupuesto de adjuntos de este turno');
    expect(plan.footer).not.toContain('quedó en el espacio de trabajo');
  });

  it('la ruta absoluta suelta, sin file://, recorre el mismo camino', async () => {
    // The literal outbox case: `/home/claw/clawd/_tmp_hoja_ruta/hoja_ruta_domiciliario.png`.
    const path = await pngOnDisk('suelta.png');
    const antes = planArtifacts(ack(envelope(path, 'suelta.png')));
    expect(antes.uploads).toHaveLength(0);

    const despues = planArtifacts(ack(await inlineLocalArtifacts(envelope(path, 'suelta.png'))));
    expect(despues.uploads).toHaveLength(1);
    const firstUpload = despues.uploads[0];
    expect(firstUpload).toBeDefined();
    if (firstUpload) {
      expect(firstUpload.bytes.equals(PNG_BYTES)).toBe(true);
    }
  });
});
