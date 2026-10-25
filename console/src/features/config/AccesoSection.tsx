import { PeopleAdminEntry } from '../auth/PeopleAdminEntry';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import { RolePoliciesPanel } from './PlatformCatalog';
import { TerminalGrantsPanel } from './TerminalGrantsPanel';
import type { ConfigWrites } from './use-config-writes';

export function AccesoSection({ ctx }: { ctx: ConfigWrites }) {
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="acceso" />
    <PeopleAdminEntry />
    <TerminalGrantsPanel />
    <RolePoliciesPanel ctx={ctx} />
    <TablasDeSeccion ctx={ctx} seccion="acceso" omitir={['role_policies']} />
  </div>;
}
