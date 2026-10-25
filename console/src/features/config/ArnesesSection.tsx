import { ArnesesPanel } from './ArnesesPanel';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import { HarnessCatalogPanel } from './PlatformCatalog';
import type { ConfigWrites } from './use-config-writes';

export function ArnesesSection({ ctx }: { ctx: ConfigWrites }) {
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="arneses" />
    <ArnesesPanel />
    <HarnessCatalogPanel ctx={ctx} />
    <TablasDeSeccion ctx={ctx} seccion="arneses" omitir={['harness_definitions']} />
  </div>;
}
