import { CONFIG_SECTIONS, type ConfigSectionId } from './sections';

/** Title, one-line purpose and the folded explanation of a section. */
export function ConfigSectionHeader({ seccion }: { seccion: ConfigSectionId }) {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.id === seccion);
  if (!section) return null;
  return <header className="grid gap-1">
    <h2 className="m-0 text-lg font-semibold tracking-tight">{section.label}</h2>
    <p className="m-0 text-[13px] text-muted">{section.proposito}</p>
    <details className="text-xs text-muted">
      <summary className="cursor-pointer">¿Qué es esto?</summary>
      <p className="m-0 mt-1 max-w-prose">{section.detalle}</p>
    </details>
  </header>;
}
