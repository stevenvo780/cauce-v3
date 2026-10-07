import type { CSSProperties } from 'react';
import { pixelIconName, type AgentAppearanceStyle } from '../api/client/agent-preferences-client';
import { cn } from '../cn';
import type { LiveState } from '../features/live/agent-state';
import { orbHues } from '../orb-hues';
import { crispIconSize } from './pixel-icons/icon-size';
import { PixelIcon } from './pixel-icons/PixelIcon';
import { useAgentAppearance } from './agent-actions/preferences-context';
import { useOrbBloom, type BloomKind } from './orb-bloom';

export interface OrbLook {
  glyph?: string | null;
  hue?: number | null;
  style?: AgentAppearanceStyle;
}

interface OrbProps {
  seed: string;
  state?: LiveState;
  size?: number;
  className?: string;
  label?: string;
  /** A drowsy trail of z's: for empty states, not for live status. */
  sleeping?: boolean;
}

const BODY = 'M3 2h4v1h1v1h1v4H8v1H6V8H4v1H2V8H1V4h1V3h1z';

/** A tiny pixel creature in the agent's hue; its eyes blink and it hops in place (styles/orb.css). */
function PixelCreature() {
  return (
    <svg viewBox="0 0 10 10" className="agent-orb-pixel" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path d={BODY} className="px-body" />
      <rect x="3" y="3" width="1" height="1" className="px-shine" />
      <rect x="3" y="4" width="1" height="2" className="px-eye" />
      <rect x="6" y="4" width="1" height="2" className="px-eye" />
      <rect x="2" y="6" width="1" height="1" className="px-cheek" />
      <rect x="7" y="6" width="1" height="1" className="px-cheek" />
    </svg>
  );
}

/** The orb as drawn from an explicit look: the customization preview uses it before anything is saved. */
export function OrbView({ seed, look, state, size = 32, className, label, sleeping = false, bloom }: OrbProps & {
  look?: OrbLook;
  bloom?: { kind: BloomKind; n: number } | null;
}) {
  const [h1, h2, h3] = orbHues(seed, look?.hue);
  const style = look?.style ?? 'orb';
  const glyph = look?.glyph ?? undefined;
  const pixelName = pixelIconName(glyph);
  const css = { width: size, height: size, '--h1': h1, '--h2': h2, '--h3': h3, '--orb-size': `${String(size)}px` } as CSSProperties;
  return (
    <span
      className={cn('agent-orb', className)}
      data-state={state}
      data-style={style}
      style={css}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {style === 'aurora' ? <span className="agent-orb-sky"><span className="agent-orb-ribbon" /><span className="agent-orb-ribbon" /></span> : null}
      {style === 'pixel' && !glyph ? <PixelCreature /> : null}
      {style === 'orb' || style === 'pulse' ? <span className="agent-orb-core" /> : null}
      {glyph ? (
        <span className="agent-orb-glyph">
          {pixelName ? <PixelIcon name={pixelName} size={crispIconSize(size * 0.6)} /> : glyph}
        </span>
      ) : null}
      {sleeping ? <span className="agent-orb-zzz"><span>z</span><span>z</span><span>z</span></span> : null}
      {bloom ? <span key={bloom.n} className="agent-orb-bloom" data-kind={bloom.kind} /> : null}
    </span>
  );
}

/**
 * The animated agent mark. Motion carries the state —calm when idle, fast with a halo when working
 * or receiving, still and grey when down— and the look (glyph, hue, style) is the one the fleet
 * chose for the agent, so it reads the same in every view. All motion lives in styles/orb.css.
 */
export function AgentOrb(props: OrbProps) {
  const appearance = useAgentAppearance(props.seed);
  const bloom = useOrbBloom(props.seed);
  return <OrbView {...props} look={appearance} bloom={bloom} />;
}
