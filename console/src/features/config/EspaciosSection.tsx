import { AltaDeEspacios } from './AltaDeEspacios';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import type { ConfigWrites } from './use-config-writes';

export function EspaciosSection({ ctx }: { ctx: ConfigWrites }) {
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="espacios" />
    <AltaDeEspacios soloLectura={ctx.soloLectura} busy={ctx.busy} onChange={ctx.canalEditor.change} />
    <TablasDeSeccion ctx={ctx} seccion="espacios" />
  </div>;
}
