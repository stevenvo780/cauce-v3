import { Button, SectionCard } from '../../components/kit';
import { useState } from 'react';
import { PeopleAdminPanel } from './PeopleAdminPanel';

export function PeopleAdminEntry() {
  const [panel, setPanel] = useState<'closed' | 'list' | 'invite'>('closed');
  const open = panel !== 'closed';
  return <SectionCard level={3} title="Personas" description="Invita a tu equipo: crea cuentas web, cambia sus permisos y retira o restaura sus accesos.">
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" aria-expanded={panel === 'invite'} onClick={() => { setPanel(panel === 'invite' ? 'closed' : 'invite'); }}>
        {panel === 'invite' ? 'Cerrar invitación' : 'Invitar persona'}
      </Button>
      <Button variant="secondary" aria-expanded={panel === 'list'} onClick={() => { setPanel(panel === 'list' ? 'closed' : 'list'); }}>
        {panel === 'list' ? 'Cerrar administración de personas' : 'Administrar personas'}
      </Button>
    </div>
    {open ? <PeopleAdminPanel startCreating={panel === 'invite'} /> : null}
  </SectionCard>;
}
