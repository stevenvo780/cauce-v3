import { useId } from 'react';
import { cn } from '../../cn';

/** Three streams —the agents— converging into one channel: the confluence that names Cauce. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6157F2" />
          <stop offset="0.55" stopColor="#4338CA" />
          <stop offset="1" stopColor="#0E7490" />
        </linearGradient>
        <linearGradient id={`${id}-flow`} x1="12" y1="0" x2="54" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#A5F3FC" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}-tile)`} />
      <path d="M0 52 C18 44 40 60 64 48 V64 H0 Z" fill="#FFFFFF" fillOpacity="0.06" />
      <g fill="none" stroke={`url(#${id}-flow)`} strokeLinecap="round" strokeWidth="4.5">
        <path d="M15 19 C29 19 31 32 47 32" />
        <path d="M15 32 H47" />
        <path d="M15 45 C29 45 31 32 47 32" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="15" cy="19" r="3.5" fillOpacity="0.8" />
        <circle cx="15" cy="32" r="3.5" fillOpacity="0.8" />
        <circle cx="15" cy="45" r="3.5" fillOpacity="0.8" />
        <circle cx="49" cy="32" r="6" />
      </g>
      <circle cx="49" cy="32" r="2.4" fill="#4338CA" />
    </svg>
  );
}

export function Logo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={compact ? 28 : 30} />
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-[17px] font-semibold tracking-tight text-fg">cauce</span>
          <span className="mt-1 text-[11px] font-medium text-muted">consola de agentes</span>
        </span>
      )}
    </span>
  );
}
