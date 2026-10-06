import { expect, it } from 'vitest';
import { messageAttachmentList, messageMediaKind, safeAttachmentName } from './message-attachment-list';

it.each([
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/webp', 'image'],
  ['image/gif', 'image'],
  ['image/svg+xml', 'document'],
  ['text/html', 'document'],
  ['audio/mpeg', 'audio'],
  ['video/mp4', 'video'],
  [undefined, 'document'],
] as const)('clasifica %s con un allowlist seguro de raster', (mime, expected) => {
  expect(messageMediaKind(mime)).toBe(expected);
});

it('conserva el índice crudo al omitir entradas históricas inválidas', () => {
  expect(messageAttachmentList([null, { name: 'foto.png', mime_type: 'image/png' }, 4, { name: 'doc.pdf' }]))
    .toMatchObject([
      { attachmentIndex: 1, name: 'foto.png', mediaKind: 'image' },
      { attachmentIndex: 3, name: 'doc.pdf', mediaKind: 'document' },
    ]);
});

it('usa kind image como fallback cuando metadatos históricos no incluyen MIME', () => {
  expect(messageAttachmentList([{ name: 'legacy-image', kind: 'image', file_size: null }]))
    .toMatchObject([{ mediaKind: 'image', size: undefined }]);
});

it('normaliza nombres de archivo para que no puedan salir del nombre local', () => {
  expect(safeAttachmentName('../../foto.png')).toBe('.._.._foto.png');
  expect(safeAttachmentName('\u0000')).toBe('_');
});
