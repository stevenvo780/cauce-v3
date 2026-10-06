import { FileText, Image } from 'lucide-react';
import { messageAttachmentList } from './message-attachment-list';
import './MessageAttachments.css';

export function MessageAttachments({ files }: { files?: unknown }) {
  const summaries = messageAttachmentList(files);
  if (summaries.length === 0) return null;
  return <ul className="chat-message-files" aria-label="Archivos del mensaje">
    {summaries.map((file, index) => <li key={`${file.name}-${String(index)}`}>
      {file.image ? <Image size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
      <span><strong>{file.name}</strong><small>{file.size === undefined ? 'Tamaño no disponible' : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(file.size / 1_000)} kB`}</small></span>
    </li>)}
  </ul>;
}
