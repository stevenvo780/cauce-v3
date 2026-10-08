import { useState } from 'react';
import { PeopleAdminPanel } from './PeopleAdminPanel';

export function PeopleAdminEntry() {
  const [open, setOpen] = useState(false);
  return <section className="settings-administration">
    <div><h2>Personas</h2><p>Crea cuentas web, cambia sus permisos y retira o restaura sus accesos.</p></div>
    <button type="button" className="button secondary" aria-expanded={open} onClick={() => { setOpen(previous => !previous); }}>
      {open ? 'Cerrar administración de personas' : 'Administrar personas'}
    </button>
    {open ? <PeopleAdminPanel /> : null}
  </section>;
}
