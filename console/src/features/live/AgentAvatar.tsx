import type { LiveState } from './agent-state';

/**
 * The doll. A single SVG whose parts are animated by CSS via `data-state`, instead of seven
 * distinct drawings: that way the transition between states is continuous (the body does not
 * jump, it changes pose) and the browser can interpolate. All animation lives in `live.css`,
 * which respects `prefers-reduced-motion`.
 *
 * The read must work WITHOUT text, which is the requirement: each state changes at once the
 * accent color, the body pose, the shape of the eyes and which accessory elements appear
 * (incoming envelope, thought bubble, outgoing package, speech bubble, alarm signal).
 */

interface EyeProps { state: LiveState }

function Eyes({ state }: EyeProps) {
  if (state === 'down') {
    return (
      <g className="av-eyes" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" fill="none">
        <path d="M40 47 L50 57 M50 47 L40 57" />
        <path d="M70 47 L80 57 M80 47 L70 57" />
      </g>
    );
  }
  if (state === 'blocked') {
    return (
      <g className="av-eyes" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" fill="none">
        <path d="M39 54 L51 54" />
        <path d="M69 54 L81 54" />
      </g>
    );
  }
  // The state formerly called `responding` had two SMILING eyes here (two upward arches). It was
  // the same lie as the green checkmark and the celebration: the console does not know whether
  // the delivery closed well. Without its own branch, it falls through to the neutral eyes below.
  if (state === 'thinking') {
    // Lower, slightly squinted gaze: it is looking at its own work, not at you.
    return (
      <g className="av-eyes" fill="currentColor">
        <rect x="39" y="52" width="12" height="6" rx="3" />
        <rect x="69" y="52" width="12" height="6" rx="3" />
      </g>
    );
  }
  return (
    <g className="av-eyes" fill="currentColor">
      <circle className="av-eye" cx="45" cy="53" r="5.5" />
      <circle className="av-eye" cx="75" cy="53" r="5.5" />
    </g>
  );
}

export function AgentAvatar({ state, overloaded = false, label }: {
  state: LiveState;
  overloaded?: boolean;
  label: string;
}) {
  return (
    <svg
      className="agent-avatar"
      data-state={state}
      data-overloaded={overloaded ? 'true' : undefined}
      viewBox="0 0 120 132"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {/* Halo: pulses to the rhythm of the state, first thing you glimpse from afar. */}
      <ellipse className="av-halo" cx="60" cy="66" rx="46" ry="46" />

      {/* Support shadow: shrinks when the doll jumps, giving weight to the movement. */}
      <ellipse className="av-shadow" cx="60" cy="120" rx="26" ry="5" />

      <g className="av-body">
        {/* Antenna and signal bulb */}
        <g className="av-antenna">
          <path className="av-antenna-stem" d="M60 30 L60 18" strokeWidth="3.2" strokeLinecap="round" fill="none" />
          <circle className="av-bulb" cx="60" cy="14" r="5.5" />
          <circle className="av-bulb-ring" cx="60" cy="14" r="5.5" fill="none" strokeWidth="2" />
        </g>

        {/* Head */}
        <g className="av-head">
          <rect className="av-head-shell" x="26" y="30" width="68" height="46" rx="17" />
          <rect className="av-visor" x="33" y="38" width="54" height="30" rx="12" />
          <Eyes state={state} />
        </g>

        {/* Torso with chest light */}
        <g className="av-torso">
          <rect className="av-torso-shell" x="34" y="80" width="52" height="34" rx="14" />
          <circle className="av-core" cx="60" cy="97" r="7" />
          <circle className="av-core-ring" cx="60" cy="97" r="7" fill="none" strokeWidth="2" />
        </g>

        {/* Arms: the right one extends when delegating, the left one receives. */}
        <path className="av-arm av-arm-left" d="M34 88 Q22 94 21 104" strokeWidth="6" strokeLinecap="round" fill="none" />
        <path className="av-arm av-arm-right" d="M86 88 Q98 94 99 104" strokeWidth="6" strokeLinecap="round" fill="none" />
      </g>

      {/* --- Per-state accessories. Each one is shown only in its state, from CSS. --- */}

      {/* receiving: an envelope flying in from the left */}
      <g className="av-fx av-fx-incoming">
        <g className="av-envelope">
          <rect x="-9" y="-6.5" width="18" height="13" rx="2.5" />
          <path d="M-9 -6.5 L0 1 L9 -6.5" fill="none" strokeWidth="1.8" strokeLinejoin="round" />
        </g>
      </g>

      {/* thinking: three bubbles rising in cascade */}
      <g className="av-fx av-fx-thinking">
        <circle className="av-think av-think-1" cx="92" cy="34" r="3.4" />
        <circle className="av-think av-think-2" cx="99" cy="25" r="4.6" />
        <circle className="av-think av-think-3" cx="107" cy="14" r="6" />
      </g>

      {/* delegating: a package shooting out to the right */}
      <g className="av-fx av-fx-delegating">
        <g className="av-packet">
          <rect x="-6" y="-6" width="12" height="12" rx="3" />
          <path d="M-6 0 L6 0 M0 -6 L0 6" strokeWidth="1.6" fill="none" />
        </g>
        <path className="av-trail" d="M92 100 L118 92" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </g>

      {/* settled: speech bubble with ellipsis. It used to be a CHECKMARK, and the checkmark
          asserted a correct closure the console cannot see: a delivery leaves `in_flight_items`
          the same whether it closed `done` or died by deadline. The three dots say what is
          actually known: something happened, and the outcome is still pending. */}
      <g className="av-fx av-fx-settled">
        <g className="av-bubble">
          <rect x="82" y="16" width="34" height="26" rx="9" />
          <path d="M92 42 L88 51 L101 42 Z" />
          <g className="av-unknown-dots">
            <circle cx="91" cy="29" r="2.6" />
            <circle cx="99" cy="29" r="2.6" />
            <circle cx="107" cy="29" r="2.6" />
          </g>
        </g>
      </g>

      {/* blocked: alarm triangle pulsing above the head */}
      <g className="av-fx av-fx-blocked">
        <g className="av-alarm">
          <path d="M60 4 L78 34 L42 34 Z" strokeWidth="3" strokeLinejoin="round" />
          <path className="av-alarm-mark" d="M60 15 L60 24" strokeWidth="3.2" strokeLinecap="round" fill="none" />
          <circle className="av-alarm-dot" cx="60" cy="29" r="1.9" />
        </g>
      </g>

      {/* down: the monitor's flat line */}
      <g className="av-fx av-fx-down">
        <path className="av-flatline" d="M18 122 L44 122 L50 116 L56 128 L62 122 L102 122" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>

      {/* overloaded: sparks above the antenna, overlaid on any working state */}
      <g className="av-fx av-fx-overloaded">
        <path className="av-spark av-spark-1" d="M44 20 L40 12" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path className="av-spark av-spark-2" d="M76 20 L80 12" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}
