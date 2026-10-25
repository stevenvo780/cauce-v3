import { Notice, PREVIEW } from '../../components/kit';
import type { ConfigMutationNotice } from './use-config-mutation';

export function ConfigChangeReceipt({ preview, notice, label }: {
  preview?: string;
  notice?: ConfigMutationNotice;
  label: string;
}) {
  return <>
    {notice ? <Notice tone={notice.tone === 'error' ? 'danger' : notice.tone === 'parcial' ? 'warn' : 'info'}
      role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</Notice> : null}
    {preview ? <details className="min-w-0 text-[13px]">
      <summary className="cursor-pointer font-medium text-muted">Detalles técnicos</summary>
      <div className="mt-2 grid min-w-0 gap-2">
        <pre className={`${PREVIEW} min-w-0 wrap-anywhere`} aria-label={label}>{preview}</pre>
      </div>
    </details> : null}
  </>;
}
