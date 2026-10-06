import { useEffect, useState } from 'react';
import { formatFileSize } from './chat-attachments';
import './chat-selected-media.css';

interface ChatSelectedMediaProps {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}

function previewKind(file: File): 'image' | 'video' | 'audio' | undefined {
  const type = file.type.split(';', 1)[0]?.trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return 'image';
  if (['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'].includes(type)) return 'video';
  if (['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/opus', 'audio/webm'].includes(type)) return 'audio';
  return undefined;
}

export function ChatSelectedMedia({ file, disabled, onRemove }: ChatSelectedMediaProps) {
  const [url, setUrl] = useState<string>();
  const kind = previewKind(file);

  useEffect(() => {
    if (!kind) return undefined;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => { URL.revokeObjectURL(objectUrl); };
  }, [file, kind]);

  return <li className="chat-selected-media">
    {url && kind === 'image' ? <img className="chat-selected-thumbnail" src={url} alt="" /> : null}
    {url && kind === 'video' ? <video className="chat-selected-player" src={url} controls playsInline preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    {url && kind === 'audio' ? <audio className="chat-selected-player" src={url} controls preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    <span className="chat-selected-name" title={file.name}>{file.name}</span>
    <small>{formatFileSize(file.size)}</small>
    <button className="button secondary composer-attachment-remove" type="button" aria-label={`Quitar ${file.name}`}
      disabled={disabled} onClick={onRemove}>×</button>
  </li>;
}
