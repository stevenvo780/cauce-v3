import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  formatFileSize,
  snapshotAttachments,
  validateAttachmentSelection,
} from './chat-attachments';

describe('adjuntos inline del chat', () => {
  it('calcula SHA-256 y base64 de bytes reales PDF, texto UTF-8 e imagen PNG', async () => {
    const files = [
      new File(['%PDF-1.4\n'], 'informe.pdf', { type: 'application/pdf' }),
      new File(['hola ñ'], 'nota.txt', { type: 'text/plain' }),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'foto.png', { type: 'image/png' }),
    ];

    await expect(snapshotAttachments(files)).resolves.toEqual([
      {
        kind: 'document', name: 'informe.pdf', mime_type: 'application/pdf', file_size: 9,
        sha256: 'e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4',
        content_base64: 'JVBERi0xLjQK',
      },
      {
        kind: 'document', name: 'nota.txt', mime_type: 'text/plain', file_size: 7,
        sha256: 'c061d8f4d40470777e310febeb96ac517b9d121cc48b09f355e9a2ed73da18d9',
        content_base64: 'aG9sYSDDsQ==',
      },
      {
        kind: 'image', name: 'foto.png', mime_type: 'image/png', file_size: 8,
        sha256: '4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6',
        content_base64: 'iVBORw0KGgo=',
      },
    ]);
  });

  it('admite cuatro archivos y el total exacto, y rechaza cantidad o total excedidos', () => {
    const perFile = MAX_ATTACHMENTS_TOTAL_BYTES / MAX_ATTACHMENTS_PER_MESSAGE;
    const four = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => (
      new File([new Uint8Array(perFile)], `file-${String(index)}.bin`, { type: 'application/octet-stream' })
    ));
    expect(() => { validateAttachmentSelection(four); }).not.toThrow();
    expect(() => { validateAttachmentSelection([...four, new File(['x'], 'fifth.txt', { type: 'text/plain' })]); })
      .toThrow(/hasta 4 archivos/u);
    expect(() => { validateAttachmentSelection([
      ...four.slice(0, 3),
      new File([new Uint8Array(perFile + 1)], 'large.bin', { type: 'application/octet-stream' }),
    ]); }).toThrow(/límite total/u);
    expect(MAX_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENTS_TOTAL_BYTES);
  });

  it('rechaza archivos vacíos, nombres inseguros y MIME inválido', () => {
    expect(() => { validateAttachmentSelection([new File([], 'empty.txt', { type: 'text/plain' })]); }).toThrow(/vacío/u);
    expect(() => { validateAttachmentSelection([new File(['x'], '../secret.txt', { type: 'text/plain' })]); }).toThrow(/nombre/u);
    expect(() => { validateAttachmentSelection([new File(['x'], 'invalid-type', { type: 'text/plain; invalid' })]); }).toThrow(/MIME/u);
  });

  it('envía archivos de tipo desconocido como documentos genéricos', async () => {
    const attachments = await snapshotAttachments([new File(['x'], 'datos.custom')]);
    expect(attachments[0]).toMatchObject({ kind: 'document', mime_type: 'application/octet-stream', content_base64: 'eA==' });
  });

  it.each([[999, '999 B'], [1_000, '1 KB'], [1_000_000, '1 MB']] as const)('muestra el tamaño %s con su unidad legible', (bytes, label) => {
    expect(formatFileSize(bytes)).toBe(label);
  });

  it('no lee bytes de un archivo que supera el máximo individual', async () => {
    const tooLarge = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.bin', { type: 'application/octet-stream' });
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    await expect(snapshotAttachments([tooLarge])).rejects.toThrow(/supera el límite/u);
    expect(read).not.toHaveBeenCalled();
  });
});
