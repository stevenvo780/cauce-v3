import type { LucideIcon } from 'lucide-react';
import { cn } from '../../cn';

export interface ModeOption<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  title?: string;
}

/** Segmented control: exactly one option is pressed and pressing it again keeps it pressed. */
export function ModeSwitch<T extends string>({ value, options, onChange, label, className }: {
  value: T;
  options: readonly ModeOption<T>[];
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-lg bg-muted-bg p-0.5', className)}>
      {options.map(({ id, label: text, icon: Icon, disabled, title }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          disabled={disabled}
          title={title}
          onClick={() => { onChange(id); }}
          className={cn(
            'flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 px-3 text-[13px] font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-45',
            value === id ? 'bg-surface text-fg shadow-card' : 'bg-transparent text-muted enabled:hover:text-fg',
          )}
        >
          <Icon size={14} aria-hidden="true" />{text}
        </button>
      ))}
    </div>
  );
}
