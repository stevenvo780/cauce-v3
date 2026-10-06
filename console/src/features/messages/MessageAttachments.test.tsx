import { render, screen } from '@testing-library/react';
import { MessageAttachments } from './MessageAttachments';

it('renders the file name and size without exposing its digest or payload', () => {
  render(<MessageAttachments files={[{ name: 'informe.pdf', mime_type: 'application/pdf', file_size: 1_500, sha256: 'f'.repeat(64) }]} />);
  expect(screen.getByRole('list', { name: 'Archivos del mensaje' })).toBeVisible();
  expect(screen.getByText('informe.pdf')).toBeVisible();
  expect(screen.getByText('1,5 kB')).toBeVisible();
  expect(document.body.textContent).not.toContain('f'.repeat(64));
});

it.each([null, {}, 'unknown', [null, 3, []]])('ignores a historical unknown list without breaking the conversation: %j', (files) => {
  render(<MessageAttachments files={files} />);
  expect(screen.queryByRole('list', { name: 'Archivos del mensaje' })).not.toBeInTheDocument();
});

it('keeps incomplete historical metadata readable', () => {
  render(<MessageAttachments files={[{ name: { invalid: true }, mime_type: null, file_size: -1 }]} />);
  expect(screen.getByText('Archivo')).toBeVisible();
  expect(screen.getByText('Tamaño no disponible')).toBeVisible();
});
