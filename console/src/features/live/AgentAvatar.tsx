import type { LiveState } from './agent-state';

/**
 * El muñeco. Un solo SVG cuyas piezas se animan por CSS según `data-state`, en vez de siete
 * dibujos distintos: así la transición entre estados es continua (el cuerpo no salta, cambia de
 * pose) y el navegador puede interpolar. Toda la animación vive en `live.css`, que respeta
 * `prefers-reduced-motion`.
 *
 * La lectura tiene que funcionar SIN texto, que es el pedido: cada estado cambia a la vez el
 * color de acento, la pose del cuerpo, la forma de los ojos y qué elementos accesorios aparecen
 * (sobre entrante, burbuja de pensamiento, paquete saliente, bocadillo, señal de alarma).
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
  // El estado que antes se llamaba `responding` tenía acá dos ojos SONRIENDO (dos arcos hacia
  // arriba). Era la misma mentira que el tilde verde y el festejo: la consola no sabe si la
  // entrega cerró bien. Sin rama propia, cae en los ojos neutros del final.
  if (state === 'thinking') {
    // Mirada baja y algo entrecerrada: está mirando su propio trabajo, no a vos.
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
      {/* Halo: late al ritmo del estado y es lo primero que se ve de reojo desde lejos. */}
      <ellipse className="av-halo" cx="60" cy="66" rx="46" ry="46" />

      {/* Sombra de apoyo: se achica cuando el muñeco salta, da peso al movimiento. */}
      <ellipse className="av-shadow" cx="60" cy="120" rx="26" ry="5" />

      <g className="av-body">
        {/* Antena y bombilla de señal */}
        <g className="av-antenna">
          <path className="av-antenna-stem" d="M60 30 L60 18" strokeWidth="3.2" strokeLinecap="round" fill="none" />
          <circle className="av-bulb" cx="60" cy="14" r="5.5" />
          <circle className="av-bulb-ring" cx="60" cy="14" r="5.5" fill="none" strokeWidth="2" />
        </g>

        {/* Cabeza */}
        <g className="av-head">
          <rect className="av-head-shell" x="26" y="30" width="68" height="46" rx="17" />
          <rect className="av-visor" x="33" y="38" width="54" height="30" rx="12" />
          <Eyes state={state} />
        </g>

        {/* Torso con luz de pecho */}
        <g className="av-torso">
          <rect className="av-torso-shell" x="34" y="80" width="52" height="34" rx="14" />
          <circle className="av-core" cx="60" cy="97" r="7" />
          <circle className="av-core-ring" cx="60" cy="97" r="7" fill="none" strokeWidth="2" />
        </g>

        {/* Brazos: el derecho se extiende al delegar, el izquierdo recibe. */}
        <path className="av-arm av-arm-left" d="M34 88 Q22 94 21 104" strokeWidth="6" strokeLinecap="round" fill="none" />
        <path className="av-arm av-arm-right" d="M86 88 Q98 94 99 104" strokeWidth="6" strokeLinecap="round" fill="none" />
      </g>

      {/* --- Accesorios por estado. Cada uno se muestra sólo en su estado, desde CSS. --- */}

      {/* recibiendo: un sobre que entra volando por la izquierda */}
      <g className="av-fx av-fx-incoming">
        <g className="av-envelope">
          <rect x="-9" y="-6.5" width="18" height="13" rx="2.5" />
          <path d="M-9 -6.5 L0 1 L9 -6.5" fill="none" strokeWidth="1.8" strokeLinejoin="round" />
        </g>
      </g>

      {/* pensando: tres burbujas que suben en cascada */}
      <g className="av-fx av-fx-thinking">
        <circle className="av-think av-think-1" cx="92" cy="34" r="3.4" />
        <circle className="av-think av-think-2" cx="99" cy="25" r="4.6" />
        <circle className="av-think av-think-3" cx="107" cy="14" r="6" />
      </g>

      {/* delegando: un paquete que sale disparado hacia la derecha */}
      <g className="av-fx av-fx-delegating">
        <g className="av-packet">
          <rect x="-6" y="-6" width="12" height="12" rx="3" />
          <path d="M-6 0 L6 0 M0 -6 L0 6" strokeWidth="1.6" fill="none" />
        </g>
        <path className="av-trail" d="M92 100 L118 92" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </g>

      {/* salió de vuelo: bocadillo con puntos suspensivos. Era un TILDE, y el tilde afirmaba un
          cierre correcto que la consola no puede ver: una entrega sale de `in_flight_items` igual
          si cerró `done` que si se murió por deadline. Los tres puntos dicen lo que sí se sabe:
          pasó algo, y el desenlace está pendiente. */}
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

      {/* bloqueado: triángulo de alarma latiendo sobre la cabeza */}
      <g className="av-fx av-fx-blocked">
        <g className="av-alarm">
          <path d="M60 4 L78 34 L42 34 Z" strokeWidth="3" strokeLinejoin="round" />
          <path className="av-alarm-mark" d="M60 15 L60 24" strokeWidth="3.2" strokeLinecap="round" fill="none" />
          <circle className="av-alarm-dot" cx="60" cy="29" r="1.9" />
        </g>
      </g>

      {/* caído: la línea plana del monitor */}
      <g className="av-fx av-fx-down">
        <path className="av-flatline" d="M18 122 L44 122 L50 116 L56 128 L62 122 L102 122" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>

      {/* saturado: chispas sobre la antena, superpuestas a cualquier estado de trabajo */}
      <g className="av-fx av-fx-overloaded">
        <path className="av-spark av-spark-1" d="M44 20 L40 12" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path className="av-spark av-spark-2" d="M76 20 L80 12" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}
