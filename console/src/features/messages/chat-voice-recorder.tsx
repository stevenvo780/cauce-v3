import { Mic, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const ICON_BUTTON = 'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-fg-2 transition-colors hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 touch-manipulation';

const AUDIO_BITRATE = 32_000;
const MAX_RECORDING_MS = 20 * 60 * 1_000;
const AUDIO_TYPES = [
  'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg',
] as const;

interface ChatVoiceRecorderProps {
  disabled: boolean;
  availableBytes: number;
  onFile: (file: File) => void;
  onRecordingChange: (recording: boolean) => void;
}

function normalizedAudioType(value: string): string | undefined {
  const bare = value.split(';', 1)[0]?.trim().toLowerCase();
  return bare === 'audio/webm' || bare === 'audio/mp4' || bare === 'audio/ogg' ? bare : undefined;
}

function supportedVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function voiceMediaDevices(): { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> } | undefined {
  const value: unknown = Reflect.get(navigator, 'mediaDevices');
  return value as { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> } | undefined;
}

function voiceRecordingUnavailableReason(): string | undefined {
  if (typeof window === 'undefined' || !Reflect.get(window, 'isSecureContext')) return 'La grabación requiere HTTPS o localhost.';
  if (!voiceMediaDevices()?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return 'Este navegador no permite grabar audio.';
  }
  if (!supportedVoiceMimeType()) return 'Este navegador no ofrece un formato de audio compatible.';
  return undefined;
}

function extensionForAudioType(type: string): string {
  return type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm';
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function stopTracks(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => { track.stop(); });
}

export function ChatVoiceRecorder({ disabled, availableBytes, onFile, onRecordingChange }: ChatVoiceRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string>();
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const stoppedRef = useRef(false);
  const recordingStartRef = useRef(0);
  const maxDurationRef = useRef(0);
  const availableBytesRef = useRef(0);
  const disabledRef = useRef(disabled);
  const onFileRef = useRef(onFile);
  const onRecordingChangeRef = useRef(onRecordingChange);
  const cancelRecordingRef = useRef<(() => void) | undefined>(undefined);

  disabledRef.current = disabled;
  onFileRef.current = onFile;
  onRecordingChangeRef.current = onRecordingChange;
  if (recording) availableBytesRef.current = Math.min(availableBytesRef.current, availableBytes);

  function clearTimer(): void {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = undefined;
  }

  function releaseStream(): void {
    stopTracks(streamRef.current);
    streamRef.current = undefined;
  }

  function cancelRecording(showError?: string): void {
    generationRef.current += 1;
    startingRef.current = false;
    clearTimer();
    chunksRef.current = [];
    recordedBytesRef.current = 0;
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    releaseStream();
    stoppedRef.current = true;
    setRecording(false);
    onRecordingChangeRef.current(false);
    setElapsedMs(0);
    if (showError) setError(showError);
  }
  cancelRecordingRef.current = () => { cancelRecording(); };

  function finishRecording(): void {
    const recorder = recorderRef.current;
    if (!recorder || stoppedRef.current || recorder.state === 'inactive') return;
    stoppedRef.current = true;
    clearTimer();
    recorder.stop();
  }

  async function startRecording(): Promise<void> {
    if (startingRef.current || recorderRef.current || disabled || availableBytes <= 0) return;
    setError(undefined);
    const unavailable = voiceRecordingUnavailableReason();
    if (unavailable) {
      setError(unavailable);
      return;
    }
    const mimeOption = supportedVoiceMimeType();
    const mimeType = mimeOption ? normalizedAudioType(mimeOption) : undefined;
    if (!mimeOption || !mimeType) {
      setError('Este navegador no ofrece un formato de audio compatible.');
      return;
    }

    startingRef.current = true;
    stoppedRef.current = false;
    const generation = ++generationRef.current;
    availableBytesRef.current = availableBytes;
    maxDurationRef.current = Math.min(MAX_RECORDING_MS, Math.floor((availableBytes * 8_000) / AUDIO_BITRATE));
    try {
      const mediaDevices = voiceMediaDevices();
      if (!mediaDevices?.getUserMedia) throw new Error('Media capture unavailable');
      const stream = await mediaDevices.getUserMedia({ audio: true });
      if (generation !== generationRef.current || disabledRef.current) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: mimeOption, audioBitsPerSecond: AUDIO_BITRATE });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordedBytesRef.current = 0;
      recordingStartRef.current = Date.now();
      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data.size || recorderRef.current !== recorder) return;
        if (recordedBytesRef.current + event.data.size > availableBytesRef.current) {
          cancelRecording('La nota de voz alcanzó el espacio disponible.');
          return;
        }
        chunksRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
      };
      recorder.onerror = () => { cancelRecording('No se pudo grabar la nota de voz.'); };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recordedBytesRef.current = 0;
        const actualType = normalizedAudioType(recorder.mimeType) ?? mimeType;
        const file = new File(chunks, `nota-de-voz.${extensionForAudioType(actualType)}`, { type: actualType });
        recorderRef.current = undefined;
        releaseStream();
        clearTimer();
        setRecording(false);
        onRecordingChangeRef.current(false);
        setElapsedMs(0);
        if (file.size > 0 && file.size <= availableBytesRef.current) onFileRef.current(file);
        else if (file.size > availableBytesRef.current) setError('La nota de voz supera el espacio disponible.');
        else setError('La grabación quedó vacía.');
      };
      recorder.start(1_000);
      startingRef.current = false;
      setRecording(true);
      onRecordingChangeRef.current(true);
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - recordingStartRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= maxDurationRef.current) finishRecording();
      }, 250);
    } catch {
      if (generation === generationRef.current) {
        startingRef.current = false;
        stoppedRef.current = true;
        const recorder = recorderRef.current;
        recorderRef.current = undefined;
        if (recorder) {
          recorder.ondataavailable = null;
          recorder.onerror = null;
          recorder.onstop = null;
          if (recorder.state !== 'inactive') recorder.stop();
        }
        releaseStream();
        setRecording(false);
        onRecordingChangeRef.current(false);
        setError('No se pudo acceder al micrófono. Revisá el permiso del navegador.');
      }
    }
  }

  useEffect(() => {
    if (disabled || availableBytes <= 0) cancelRecordingRef.current?.();
  }, [availableBytes, disabled]);

  useEffect(() => () => {
    generationRef.current += 1;
    clearTimer();
    chunksRef.current = [];
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    releaseStream();
  }, []);

  const capabilityError = voiceRecordingUnavailableReason();
  const cannotRecord = disabled || availableBytes <= 0 || Boolean(capabilityError);

  return <div className="relative flex min-w-0 shrink-0 items-center gap-1">
    {recording ? <>
      <span className="flex items-center gap-1.5 px-1.5 text-xs text-danger-ink tabular-nums" role="timer" aria-label={`Duración ${formatDuration(elapsedMs)}`}>
        <span className="size-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />{formatDuration(elapsedMs)}
      </span>
      <button className={ICON_BUTTON} type="button" onClick={finishRecording} aria-label="Finalizar nota de voz" title="Finalizar">
        <Square size={15} aria-hidden="true" />
      </button>
      <button className={ICON_BUTTON} type="button" onClick={() => { cancelRecording(); }} aria-label="Cancelar grabación" title="Cancelar">
        <X size={16} aria-hidden="true" />
      </button>
    </> : <button className={ICON_BUTTON} type="button" disabled={cannotRecord}
      title={capabilityError ?? (availableBytes <= 0 ? 'No queda espacio para adjuntar audio.' : 'Grabar nota de voz')}
      aria-label="Grabar nota de voz" onClick={() => { void startRecording(); }}>
      <Mic size={18} aria-hidden="true" />
    </button>}
    {error ? <span className="absolute bottom-[calc(100%+6px)] left-0 z-10 w-[min(260px,calc(100vw-110px))] rounded-lg border border-line bg-surface p-2 text-xs text-danger-ink shadow-pop" role="alert">{error}</span> : null}
  </div>;
}
