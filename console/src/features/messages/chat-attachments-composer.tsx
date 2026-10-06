import { ChevronDown, CircleOff, LockKeyhole, Paperclip, Send, X } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { JobLane } from '../../api/types';
import { formatFileSize, MAX_ATTACHMENTS_PER_MESSAGE, validateAttachmentSelection } from './chat-attachments';

interface ChatAttachmentsComposerProps {
  agentId: string;
  agentAlias: string;
  canPublish: boolean;
  route: { allowed: boolean; reason: string; sourceRoomIds: string[] };
  roomChoiceRequired: boolean;
  roomId: string;
  roomUnavailable: boolean;
  lane: JobLane;
  text: string;
  files: File[];
  sending: boolean;
  confirming: boolean;
  notice?: { tone: 'success' | 'error' | 'parcial'; text: string };
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onTextChange: (text: string) => void;
  onRoomChange: (roomId: string) => void;
  onFilesChange: (files: File[]) => void;
}

export function ChatAttachmentsComposer({
  agentId, agentAlias, canPublish, route, roomChoiceRequired, roomId, roomUnavailable,
  lane, text, files, sending, confirming, notice, onSubmit, onTextChange, onRoomChange, onFilesChange,
}: ChatAttachmentsComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<string>();
  const canSend = canPublish && route.allowed && Boolean(roomId) && !roomUnavailable;
  const editingBlocked = sending && !confirming;

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!selected.length) return;
    try {
      const next = [...files, ...selected];
      validateAttachmentSelection(next);
      onFilesChange(next);
      setAttachmentError(undefined);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : 'No se pudieron adjuntar esos archivos.');
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="messenger-composer" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={`messenger-input-${agentId}`}>Mensaje para {agentAlias}</label>
      {roomChoiceRequired ? <label className="messenger-room-select">Room de origen
        <span className="room-select-wrap">
          <select value={roomId} disabled={sending} onChange={(event) => { onRoomChange(event.target.value); }}>
            <option value="" disabled>Elegí la sala de origen</option>
            {roomUnavailable ? <option value={roomId} disabled>{roomId} · no disponible</option> : null}
            {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </label> : null}
      {roomUnavailable ? <p className="composer-blocked" role="alert">La sala elegida ya no está disponible. Elegí otra sala antes de enviar; el borrador se conserva.</p>
        : route.allowed && !roomId ? <p className="composer-blocked" role="note">Elegí una sala de origen antes de enviar.</p> : null}
      {lane === 'batch' ? <p className="messenger-room-fixed">Envío en segundo plano · cambiá el carril en Más.</p> : null}
      <div className="composer-input-row">
        <input ref={fileInput} className="composer-file-input" type="file" multiple tabIndex={-1}
          aria-hidden="true" onChange={handleFiles} disabled={!canSend || editingBlocked} />
        <button className="button secondary composer-attach" type="button" aria-label="Adjuntar archivos"
          title="Adjuntar archivos" disabled={!canSend || editingBlocked || files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          onClick={() => { fileInput.current?.click(); }}
          onPointerDown={(event) => {
            if (event.button === 0 && document.activeElement?.matches('.messenger-composer textarea')) event.preventDefault();
          }}><Paperclip size={18} aria-hidden="true" /></button>
        <textarea id={`messenger-input-${agentId}`} value={text} onChange={(event) => { onTextChange(event.target.value); }}
          onKeyDown={handleKeyDown} rows={1} maxLength={8_000} placeholder="Escribí un mensaje…"
          disabled={!canSend || editingBlocked} />
        <div className="composer-footer">
          <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
          <button className="button primary" type="submit" disabled={!canSend || sending || (!text.trim() && files.length === 0)}
            onPointerDown={(event) => {
              if (event.button === 0 && document.activeElement?.matches('.messenger-composer textarea')) event.preventDefault();
            }}>
            <Send size={15} aria-hidden="true" /><span>{sending ? confirming || notice?.tone === 'success' ? 'Confirmando…' : 'Enviando…' : 'Enviar'}</span>
          </button>
        </div>
      </div>
      {files.length ? <ul className="composer-attachments" aria-label="Archivos adjuntos">
        {files.map((file, index) => <li key={`${file.name}:${String(index)}`}>
          <span title={file.name}>{file.name}</span><small>{formatFileSize(file.size)}</small>
          <button className="button secondary composer-attachment-remove" type="button" aria-label={`Quitar ${file.name}`}
            disabled={editingBlocked} onClick={() => { onFilesChange(files.filter((_, currentIndex) => currentIndex !== index)); setAttachmentError(undefined); }}>
            <X size={16} aria-hidden="true" />
          </button>
        </li>)}
      </ul> : null}
      {attachmentError ? <p className="composer-blocked" role="alert">{attachmentError}</p> : null}
      {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere el permiso message.publish.</p> : null}
      {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
      {notice && notice.tone !== 'success'
        ? <p className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>
        : null}
    </form>
  );
}
