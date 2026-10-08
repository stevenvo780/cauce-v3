import { Button, SectionCard } from '../../components/kit';
import { useState } from 'react';
import { PeopleAdminPanel } from './PeopleAdminPanel';

export function PeopleAdminEntry() {
  const [open, setOpen] = useState(false);
  return <SectionCard level={3} title="Personas" description="Crea cuentas web, cambia sus permisos y retira o restaura sus accesos.">
    <Button aria-expanded={open} onClick={() => { setOpen(previous => !previous); }}>
      {open ? 'Cerrar administración de personas' : 'Administrar personas'}
    </Button>
    {open ? <PeopleAdminPanel /> : null}
  </SectionCard>;
}
