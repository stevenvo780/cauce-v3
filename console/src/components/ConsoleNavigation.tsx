import { ChevronDown, Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NAV_ENTRIES, PRIMARY_NAV_IDS, useNavAvailability } from '../nav';
import { onNavClick } from '../router';

export function ConsoleNavigation({ routeId, rail, id }: { routeId: string; rail: boolean; id: string }) {
  const availability = useNavAvailability();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const primary = new Set(PRIMARY_NAV_IDS);
  const secondary = !primary.has(routeId);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function entry(item: (typeof NAV_ENTRIES)[number]) {
    const available = availability(item.id);
    if (available.hidden) return null;
    const Icon = item.icon;
    return <li key={item.id}>
      <a href={`/${item.id}`} onClick={(event) => { onNavClick(event, `/${item.id}`, available.reason); }}
        aria-current={routeId === item.id ? 'page' : undefined}
        aria-disabled={available.disabled || undefined} className={available.disabled ? 'nav-inerte' : undefined}
        aria-label={item.label} data-navigation-label={primary.has(item.id) ? item.label : undefined}
        title={available.reason ?? (rail ? item.label : undefined)}>
        <Icon size={19} aria-hidden={true} /><span>{item.label}</span>
      </a>
    </li>;
  }

  return <nav id={id} ref={container} aria-label="Navegación principal" onKeyDown={(event) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
  }}>
    <ul>
      {NAV_ENTRIES.filter((item) => primary.has(item.id)).map(entry)}
      <li>
        <button className="tools-trigger" type="button" ref={trigger} aria-expanded={open}
          aria-controls="console-tools" aria-label="Herramientas" data-active={secondary || undefined}
          data-navigation-label="Herramientas" aria-current={secondary ? 'true' : undefined}
          title={rail ? 'Herramientas' : undefined} onClick={() => { setOpen(!open); }}>
          <Settings2 size={19} aria-hidden="true" /><span>Herramientas</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        {open ? <section className="tools-menu" id="console-tools" aria-label="Herramientas de Cauce">
          <header><strong>Tu espacio de trabajo</strong><button type="button" className="tools-close" aria-label="Cerrar herramientas" onClick={close}><X size={18} aria-hidden="true" /></button></header>
          <p>Sesiones, consumo y configuración</p>
          <ul>{NAV_ENTRIES.filter((item) => !primary.has(item.id)).map(entry)}</ul>
        </section> : null}
      </li>
    </ul>
  </nav>;
}
