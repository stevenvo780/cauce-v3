import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64CharacterBudget, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, objectRecord
} from '@cauce/protocol';
import {
  artifactRefs, attachmentsFromArtifacts, declaredArtifactBudget,
  MAX_ARTIFACT_PAYLOAD_CHARACTERS, MAX_ARTIFACT_URI_CHARACTERS
} from '../src/repository/agents/delegated-attachments.js';
import { withoutInlineArtifactBytes } from '../src/repository/artifact-payload.js';

/**
 * Referencias de artefactos entre agentes: lo que se lee de un `data:` y lo que sobrevive de él
 * sin tocar la base de datos.
 */

const PURE = 'artifact references without a database';

function payload(size: number, seed: number): Buffer {
  return Buffer.alloc(size, seed);
}

function dataUri(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const informe = payload(2048, 0x25);
const INFORME_BASE64 = informe.toString('base64');
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/** Caso, URI y el tipo con el que viaja: el declarado, o el de por defecto si no hay ninguno. */
const FORMAS_QUE_EL_EGRESO_SUBE: readonly (readonly [string, string, string])[] = [
  ['canonical', dataUri('application/pdf', informe), 'application/pdf'],
  [
    'base64 wrapped in lines',
    `data:application/pdf;base64,${INFORME_BASE64.slice(0, 12)}\n${INFORME_BASE64.slice(12)}`,
    'application/pdf'
  ],
  ['no media type', `data:;base64,${INFORME_BASE64}`, DEFAULT_MEDIA_TYPE],
  ['an uppercase scheme', `DATA:application/pdf;base64,${INFORME_BASE64}`, 'application/pdf'],
  [
    'a charset before base64',
    `data:application/pdf;charset=utf-8;base64,${INFORME_BASE64}`, 'application/pdf'
  ],
  ['BASE64 in caps', `data:application/pdf;BASE64,${INFORME_BASE64}`, 'application/pdf'],
  [
    'base64 in the middle',
    `data:application/pdf;base64;charset=utf-8,${INFORME_BASE64}`, 'application/pdf'
  ]
];

const LOCATOR_PROBE_CHARACTERS = 4_000_018;

function hugeLocator(index: number): string {
  const prefix = `https://ejemplo.invalid/${String(index)}/`;
  return prefix + 'a'.repeat(LOCATOR_PROBE_CHARACTERS - prefix.length);
}

describe(PURE, () => {
  it('derives the size from the base64 of a data uri', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: dataUri('application/pdf', informe),
      media_type: 'application/pdf', sha256: digest(informe)
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      sha256: digest(informe), size: informe.length
    }]);
  });

  it('labels the digest of a pruned reference as declared, never as verified', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: 'cauce:inline-omitted',
      media_type: 'application/pdf', sha256: digest(informe), size: informe.length
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      declared_sha256: digest(informe), size: informe.length
    }]);
  });

  it('keeps an https locator so the recipient can still fetch it', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf',
      media_type: 'application/pdf', sha256: digest(informe)
    }])).toEqual([{
      name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf',
      media_type: 'application/pdf', declared_sha256: digest(informe)
    }]);
  });

  it('recomputes the digest of the bytes it can see, overwriting a false one', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: dataUri('application/pdf', informe), sha256: 'f'.repeat(64)
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      sha256: digest(informe), size: informe.length
    }]);
  });

  it('bounds five multi-megabyte locators instead of carrying them upward', () => {
    const refs = artifactRefs([1, 2, 3, 4, 5].map((index) => ({
      name: `parte-${String(index)}.pdf`, uri: hugeLocator(index), sha256: digest(informe)
    })));

    expect(refs.length).toBeLessThanOrEqual(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(refs.every((ref) => ref.uri === undefined)).toBe(true);
    expect(JSON.stringify(refs).length).toBeLessThan(1024);
  });

  it('reads the same artifact as the pruning pass does, whitespace and case included', () => {
    const bytes = payload(64, 0x5a);
    const carried = attachmentsFromArtifacts([
      { name: 'informe.txt', uri: `  DATA:text/plain;base64,${bytes.toString('base64')}  ` }
    ]);

    expect(carried.refs).toEqual([]);
    expect(carried.dropped).toBe(0);
    expect(carried.attachments).toEqual([{
      kind: 'document', name: 'informe.txt', mime_type: 'text/plain',
      file_size: bytes.length, sha256: digest(bytes), content_base64: bytes.toString('base64')
    }]);
  });

  /* Every shape `PARIDAD_CON_EL_EGRESO` pins for the human egress, on the delegation edge: this
     reader had its own `;base64`-last rule, so five of them lost the file AND told the delegated
     agent it could not be decoded -- about bytes the bridge does upload. */
  it.each(FORMAS_QUE_EL_EGRESO_SUBE)(
    'attaches the shape the egress uploads: %s', (_caso, uri, mimeType) => {
      const carried = attachmentsFromArtifacts([{ name: 'informe.pdf', uri }]);

      expect(carried.dropped).toBe(0);
      expect(carried.note).toBeUndefined();
      expect(carried.attachments).toEqual([{
        kind: 'document', name: 'informe.pdf', mime_type: mimeType,
        file_size: informe.length, sha256: digest(informe),
        content_base64: informe.toString('base64')
      }]);
    }
  );

  it.each(FORMAS_QUE_EL_EGRESO_SUBE)(
    'keeps size and digest on the return hop for the same shape: %s', (_caso, uri, mimeType) => {
      expect(artifactRefs([{ name: 'informe.pdf', uri }])).toEqual([{
        name: 'informe.pdf', media_type: mimeType,
        sha256: digest(informe), size: informe.length
      }]);
    }
  );

  it('falls back to the default type instead of dropping a file typed unusably', () => {
    const carried = attachmentsFromArtifacts([
      { name: 'informe.bin', uri: `data:app(x)/pdf;base64,${informe.toString('base64')}` }
    ]);

    expect(carried.dropped).toBe(0);
    expect(carried.attachments[0]).toMatchObject({
      mime_type: DEFAULT_MEDIA_TYPE, sha256: digest(informe), file_size: informe.length
    });
  });

  it('counts the stored base64 of a broadcast, never the decoded bytes', () => {
    const bytes = payload(3_000, 0x21);
    const base64 = bytes.toString('base64');

    expect(declaredArtifactBudget([
      { name: 'uno.bin', uri: dataUri('application/octet-stream', bytes) },
      { name: '../../etc/passwd', uri: dataUri('text/plain', bytes) },
      { name: 'tres.bin', uri: 'file:///etc/passwd' }
    ])).toEqual({ bytes: base64.length, deliverable: 1 });
    expect(base64.length).toBeGreaterThan(bytes.length);
  });

  it('never returns bytes, a traversal name or a bogus media type', () => {
    expect(artifactRefs([
      { name: '../../etc/passwd', uri: 'cauce:inline-omitted' },
      { name: 'raro.bin', uri: 'cauce:inline-omitted', media_type: 'no es un tipo', size: -1 }
    ])).toEqual([{ name: 'raro.bin' }]);
    expect(artifactRefs('informe.pdf')).toEqual([]);
  });
});


/* 76 columns is what `base64` emits by default, and a line break is payload the parser strips: a
   file wrapped that way measures more CHARACTERS than its bytes ever will. The egress caps the
   stripped payload, so this edge must too -- reading the raw length instead refused a 10 MB
   attachment Telegram had already uploaded and left its durable descriptor without a digest. */
const WRAP_COLUMNS = /(.{76})/gu;
const OLD_RAW_CAP = base64CharacterBudget(MAX_ATTACHMENT_BYTES);

function wrappedDataUri(bytes: Buffer): string {
  return `data:application/pdf;base64,${bytes.toString('base64').replace(WRAP_COLUMNS, '$1\n')}`;
}

function prunedArtifact(uri: string, entry: Record<string, unknown> = {}): unknown {
  const result = { output: { reply: null, status: 'done', artifacts: [{ ...entry, uri }] } };
  const pruned = objectRecord(objectRecord(withoutInlineArtifactBytes(result))?.output)?.artifacts;
  return Array.isArray(pruned) ? pruned[0] : undefined;
}

describe('a file wrapped in lines is the same file', () => {
  it('attaches a 10 MB payload whose wrapped string is above the old character cap', () => {
    const bytes = payload(MAX_ATTACHMENT_BYTES, 0x11);
    const uri = wrappedDataUri(bytes);
    expect(uri.length).toBeGreaterThan(OLD_RAW_CAP);

    const carried = attachmentsFromArtifacts([{ name: 'informe.pdf', uri }]);

    expect(carried.dropped).toBe(0);
    expect(carried.note).toBeUndefined();
    expect(carried.attachments[0]).toMatchObject({
      mime_type: 'application/pdf', file_size: bytes.length, sha256: digest(bytes)
    });
  });

  /* Sin nombre ni tipo declarado: el descriptor pelado `{uri}` era el recibo en blanco de un
     fichero que la persona sí recibió, y los bytes ya no están en ninguna otra copia. */
  it('keeps type, size and digest in the durable descriptor of a wrapped payload', () => {
    const bytes = payload(MAX_ATTACHMENT_BYTES, 0x12);

    expect(prunedArtifact(wrappedDataUri(bytes))).toEqual({
      media_type: 'application/pdf', sha256: digest(bytes), size: bytes.length,
      uri: 'cauce:inline-omitted'
    });
  });

  it('drops the payload that exceeds the budget once stripped, and says so', () => {
    const bytes = payload(MAX_ATTACHMENT_BYTES + 500_000, 0x13);
    const uri = wrappedDataUri(bytes);
    expect(uri.length).toBeLessThan(MAX_ARTIFACT_URI_CHARACTERS);
    expect(uri.length - uri.indexOf(',') - 1).toBeGreaterThan(MAX_ARTIFACT_PAYLOAD_CHARACTERS);

    const carried = attachmentsFromArtifacts([{ name: 'grande.pdf', uri }]);

    expect(carried.attachments).toEqual([]);
    expect(carried.note).toBe('1 adjunto(s) no viajaron: exceden el cupo del mensaje');
  });
});

describe('a file that travels by reference to the blob store', () => {
  const BLOB_SHA = 'b'.repeat(64);
  const BLOB_URI = `cauce-blob:sha256:${BLOB_SHA}`;
  const BIG = 1_200_000_000;

  it('keeps the blob locator, its size past the inline ceiling and its digest as declared', () => {
    const carried = attachmentsFromArtifacts([
      { name: 'video.mp4', uri: BLOB_URI, media_type: 'video/mp4', size: BIG, sha256: BLOB_SHA }
    ]);
    expect(carried.attachments).toEqual([]);
    expect(carried.dropped).toBe(0);
    expect(carried.refs).toEqual([
      { name: 'video.mp4', uri: BLOB_URI, media_type: 'video/mp4', declared_sha256: BLOB_SHA, size: BIG }
    ]);
    expect(artifactRefs([{ name: 'video.mp4', uri: BLOB_URI, media_type: 'video/mp4', size: BIG }]))
      .toEqual([{ name: 'video.mp4', uri: BLOB_URI, media_type: 'video/mp4', declared_sha256: BLOB_SHA, size: BIG }]);
  });

  it('still bounds an inline-shaped size claim by the inline ceiling', () => {
    const [ref] = artifactRefs([{ name: 'x.bin', uri: 'https://example.test/x.bin', size: BIG }]);
    expect(ref?.size).toBeUndefined();
  });
});
