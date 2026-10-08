import { useEffect, useState } from 'react';
import { formatFileSize } from './chat-attachments';
import { X } from 'lucide-react';

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

  return <li className="flex max-w-full min-w-0 items-center gap-2 rounded-xl border border-line bg-subtle py-1 pr-1 pl-2 text-xs">
    {url && kind === 'image' ? <img className="size-9 shrink-0 rounded-md object-cover" src={url} alt="" /> : null}
    {url && kind === 'video' ? <video className="h-9 w-[min(160px,42vw)] shrink-0" src={url} controls playsInline preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    {url && kind === 'audio' ? <audio className="h-9 w-[min(160px,42vw)] shrink-0" src={url} controls preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    <span className="grid min-w-0">
      <span className="max-w-48 truncate font-medium text-fg" title={file.name}>{file.name}</span>
      <small className="text-[11px] text-muted">{formatFileSize(file.size)}</small>
    </span>
    <button type="button" aria-label={`Quitar ${file.name}`} disabled={disabled} onClick={onRemove}
      className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
      <X size={14} aria-hidden="true" />
    </button>
  </li>;
}
