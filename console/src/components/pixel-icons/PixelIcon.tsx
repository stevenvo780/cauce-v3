import { useSyncExternalStore, type CSSProperties } from 'react';
import { cn } from '../../cn';
import { pixelIconPath, requestPixelIcon, subscribePixelIcons } from './pixel-icon-cache';

interface PixelIconProps {
  name: string;
  /** Rounded to whole pixels so the 24-unit grid stays crisp. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** A pixelarticons glyph drawn inline in currentColor; renders an empty box until its chunk arrives. */
export function PixelIcon({ name, size = 24, className, style }: PixelIconProps) {
  requestPixelIcon(name);
  const path = useSyncExternalStore(subscribePixelIcons, () => pixelIconPath(name), () => undefined);
  const px = Math.max(1, Math.round(size));
  return (
    <svg
      viewBox="0 0 24 24" width={px} height={px} fill="currentColor" shapeRendering="crispEdges"
      className={cn('pixel-icon', className)} style={style} aria-hidden="true" focusable="false"
    >
      {path ? <path d={path} /> : null}
    </svg>
  );
}
