import { PeopleAdminEntry } from '../auth/PeopleAdminEntry';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import type { ConfigWrites } from './use-config-writes';

export function AccesoSection({ ctx }: { ctx: ConfigWrites }) {
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="acceso" />
    <PeopleAdminEntry />
    <TablasDeSeccion ctx={ctx} seccion="acceso" />
  </div>;
}
