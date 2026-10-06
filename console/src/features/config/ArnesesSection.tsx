import { ArnesesPanel } from './ArnesesPanel';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import type { ConfigWrites } from './use-config-writes';

export function ArnesesSection({ ctx }: { ctx: ConfigWrites }) {
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="arneses" />
    <ArnesesPanel />
    <TablasDeSeccion ctx={ctx} seccion="arneses" />
  </div>;
}
