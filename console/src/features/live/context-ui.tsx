import { Tabs } from '@base-ui/react/tabs';
import { useId, type ReactNode } from 'react';
import { cn } from '../../cn';
import { DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN, problemaDeMotivo } from './ficheros-motivo';

/**
 * The hand-typed reason that every context write carries into the audit row. One field, one rule:
 * the caller decides when the write is blocked, this decides what the person sees about the text.
 */
export function ReasonField({ label = 'Motivo del cambio', value, onChange, disabled, placeholder, className }: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const problem = problemaDeMotivo(value);
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id} type="text" value={value} maxLength={DOCUMENT_REASON_MAX} autoComplete="off" spellCheck={false}
        placeholder={placeholder ?? 'Por qué hacés este cambio…'} disabled={disabled}
        aria-describedby={`${id}-hint`} onChange={(event) => { onChange(event.target.value); }}
      />
      <p id={`${id}-hint`} className={cn('m-0 text-xs', value.length > 0 && problem ? 'text-danger-ink' : 'text-muted')}>
        {value.length === 0
          ? `Lo escribe una persona y queda en la auditoría (${String(DOCUMENT_REASON_MIN)} a ${String(DOCUMENT_REASON_MAX)} caracteres).`
          : problem ?? `Motivo válido · ${String(value.trim().length)}/${String(DOCUMENT_REASON_MAX)}`}
      </p>
    </div>
  );
}

const TAB_BASE = 'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 bg-transparent font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-brand data-[active]:text-fg';
const TAB_STYLE = {
  line: `${TAB_BASE} -mb-px border-b-2 border-transparent px-3 py-2.5 text-[13px] data-[active]:border-brand`,
  chip: `${TAB_BASE} rounded-full border border-line bg-surface px-2.5 py-1 text-xs hover:bg-subtle data-[active]:border-transparent data-[active]:bg-brand-soft data-[active]:text-brand-ink`,
};

/** A tab strip without indicator elements: the active state is plain `data-active` styling. */
export function TabStrip({ label, variant = 'line', tabs, className }: {
  label: string;
  variant?: keyof typeof TAB_STYLE;
  tabs: readonly { id: string; label: ReactNode }[];
  className?: string;
}) {
  return (
    <Tabs.List aria-label={label}
      className={cn('flex', variant === 'line' ? 'gap-1 overflow-x-auto border-b border-line' : 'flex-wrap gap-1.5', className)}>
      {tabs.map((tab) => <Tabs.Tab key={tab.id} value={tab.id} className={TAB_STYLE[variant]}>{tab.label}</Tabs.Tab>)}
    </Tabs.List>
  );
}
