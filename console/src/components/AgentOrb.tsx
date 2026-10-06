import type { CSSProperties } from 'react';
import { cn } from '../cn';
import type { LiveState } from '../features/live/agent-state';
import { orbHues } from '../orb-hues';

/**
 * The animated agent mark: a slowly turning conic gradient seeded by the alias. Motion carries the
 * state —calm when idle, fast with a halo when working or receiving, still and grey when down— so
 * the orb reads at a glance without a label. All motion lives in styles/orb.css.
 */
export function AgentOrb({ seed, state, size = 32, className, label }: {
  seed: string;
  state?: LiveState;
  size?: number;
  className?: string;
  label?: string;
}) {
  const [h1, h2, h3] = orbHues(seed);
  const style = { width: size, height: size, '--h1': h1, '--h2': h2, '--h3': h3 } as CSSProperties;
  return (
    <span
      className={cn('agent-orb', className)}
      data-state={state}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span className="agent-orb-core" />
    </span>
  );
}
