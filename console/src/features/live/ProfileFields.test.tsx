import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { ProfileFields } from './ProfileFields';
import { CAMPOS_DEL_PERFIL, ETIQUETAS, camposVigentes, destinosDelArnes, lineasCrudas } from './perfil';
import { perfilAplicado } from './perfil-fixtures';

function setup({ harness = 'claude', files = ['CLAUDE.md'], disabled = false }: {
  harness?: string | null;
  files?: string[];
  disabled?: boolean;
} = {}) {
  const onTextChange = vi.fn();
  const onListChange = vi.fn();
  const props = {
    fields: camposVigentes(undefined, undefined),
    destinations: destinosDelArnes(harness, files.map((nombre) => ({ nombre }))),
    limits: perfilAplicado().limites,
    disabled, onTextChange, onListChange,
  };
  return { ...render(<ProfileFields {...props} />), props, onTextChange, onListChange };
}

it('organizes all seven editable fields into three named groups without hiding inputs', () => {
  setup();
  expect(screen.getAllByRole('group').filter((group) => group.tagName === 'FIELDSET')).toHaveLength(3);
  const identity = screen.getByRole('group', { name: 'Identidad y relación' });
  const work = screen.getByRole('group', { name: 'Responsabilidades y herramientas' });
  const rules = screen.getByRole('group', { name: 'Límites y forma de trabajar' });
  expect(within(identity).getAllByRole('textbox')).toHaveLength(3);
  expect(within(work).getAllByRole('textbox')).toHaveLength(2);
  expect(within(rules).getAllByRole('textbox')).toHaveLength(2);
  for (const field of CAMPOS_DEL_PERFIL) {
    expect(screen.getByRole('textbox', { name: ETIQUETAS[field].titulo })).toBeVisible();
  }
  expect(screen.getByText(/Declarar herramientas no concede acceso/)).toBeInTheDocument();
});

it('keeps optional examples closed and never inserts them or changes a draft when toggled', async () => {
  const { container, onTextChange, onListChange } = setup();
  const user = userEvent.setup();
  const details = [...container.querySelectorAll('details')];
  expect(details).toHaveLength(3);
  for (const disclosure of details) {
    expect(disclosure).not.toHaveAttribute('open');
    const summary = within(disclosure).getByText(/^Ver ejemplos:/);
    await user.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByText('Ejemplos orientativos; no se añaden al perfil.')).toBeVisible();
    expect(within(disclosure).queryByRole('button')).not.toBeInTheDocument();
    await user.click(summary);
    expect(disclosure).not.toHaveAttribute('open');
  }
  expect(onTextChange).not.toHaveBeenCalled();
  expect(onListChange).not.toHaveBeenCalled();
  for (const input of screen.getAllByRole('textbox')) expect(input).toHaveValue('');
});

it.each([
  ['claude', 'CLAUDE.md'], ['codex', 'AGENTS.md'], ['muse', 'AGENTS.md'],
])('keeps the verified destination for every %s field', (harness, file) => {
  setup({ harness, files: [file] });
  for (const field of CAMPOS_DEL_PERFIL) {
    const input = screen.getByRole('textbox', { name: ETIQUETAS[field].titulo });
    expect(input).toHaveAccessibleDescription(expect.stringContaining(file));
    expect(input).toHaveAccessibleDescription(expect.stringContaining(ETIQUETAS[field].ayuda));
  }
});

it('keeps OpenClaw destinations separate and never promises an unpublished file', () => {
  setup({ harness: 'openclaw', files: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md'] });
  const mapping = {
    purpose: 'SOUL.md', role_summary: 'IDENTITY.md', human_brief: 'USER.md',
    responsibilities: 'AGENTS.md', restrictions: 'AGENTS.md', operating_rules: 'AGENTS.md',
  };
  for (const [field, file] of Object.entries(mapping)) {
    const name = ETIQUETAS[field as keyof typeof mapping].titulo;
    expect(screen.getByRole('textbox', { name })).toHaveAccessibleDescription(expect.stringContaining(file));
  }
  const tools = screen.getByRole('textbox', { name: ETIQUETAS.tools.titulo });
  expect(tools.closest('label')).toHaveTextContent('sin dato');
  expect(tools.closest('label')?.querySelector('.perfil-destino')).not.toHaveTextContent('→ TOOLS.md');
});

it.each([
  [null, 'sin dato'], ['unknown-harness', 'no aplica'],
])('preserves destination uncertainty for %s', (harness, absence) => {
  setup({ harness, files: [] });
  for (const input of screen.getAllByRole('textbox')) {
    if (absence === 'no aplica') expect(input.closest('label')?.querySelector('[aria-label="no aplica"]')).toBeInTheDocument();
    else expect(input.closest('label')).toHaveTextContent(absence);
  }
});

it('preserves raw list whitespace, text and edits while opening or closing guidance', async () => {
  const user = userEvent.setup();
  function Draft() {
    const [fields, setFields] = useState<AgentPerfilCampos>(camposVigentes(undefined, undefined));
    return <ProfileFields fields={fields} limits={perfilAplicado().limites} disabled={false}
      destinations={destinosDelArnes('claude', [{ nombre: 'CLAUDE.md' }])}
      onTextChange={(field, value) => { setFields((current) => ({ ...current, [field]: value })); }}
      onListChange={(field, value) => { setFields((current) => ({ ...current, [field]: lineasCrudas(value) })); }} />;
  }
  render(<Draft />);
  const purpose = screen.getByRole('textbox', { name: ETIQUETAS.purpose.titulo });
  const responsibilities = screen.getByRole('textbox', { name: ETIQUETAS.responsibilities.titulo });
  await user.type(purpose, 'Mi propósito');
  await user.type(responsibilities, 'Primera tarea {enter}{enter} Segunda tarea ');
  const summary = screen.getByText('Ver ejemplos: responsabilidades y herramientas');
  await user.click(summary);
  await user.click(summary);
  expect(purpose).toHaveValue('Mi propósito');
  expect(responsibilities).toHaveValue('Primera tarea \n\n Segunda tarea ');
  expect(responsibilities).toHaveAccessibleDescription(expect.stringContaining('2 entradas / 64'));
});

it('retains input counts, limits, callbacks and disabled state without coupling guidance to edits', async () => {
  const { props, rerender, onTextChange, onListChange } = setup();
  for (const field of CAMPOS_DEL_PERFIL) {
    const input = screen.getByRole('textbox', { name: ETIQUETAS[field].titulo });
    fireEvent.change(input, { target: { value: ' texto \n siguiente ' } });
  }
  expect(onTextChange.mock.calls).toEqual([
    ['purpose', ' texto \n siguiente '], ['role_summary', ' texto \n siguiente '], ['human_brief', ' texto \n siguiente '],
  ]);
  expect(onListChange.mock.calls).toEqual([
    ['responsibilities', ' texto \n siguiente '], ['restrictions', ' texto \n siguiente '],
    ['tools', ' texto \n siguiente '], ['operating_rules', ' texto \n siguiente '],
  ]);
  const fields = { ...props.fields, purpose: '😀😀', responsibilities: ['one', '', ' two '] };
  const limits: AgentPerfil['limites'] = { purpose: 3, role_summary: 4, items: 1, item: 10, total: 20 };
  rerender(<ProfileFields {...props} fields={fields} limits={limits} disabled />);
  expect(screen.getByText('4 / 3')).toHaveClass('perfil-cuenta-fuera');
  expect(screen.getByText('2 entradas / 1')).toHaveClass('perfil-cuenta-fuera');
  for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
  const callsBeforeGuidance = onTextChange.mock.calls.length + onListChange.mock.calls.length;
  await userEvent.click(screen.getByText('Ver ejemplos: identidad y relación'));
  expect(onTextChange.mock.calls.length + onListChange.mock.calls.length).toBe(callsBeforeGuidance);
});

it('keeps unknown limits distinct from zero and provides unique labels for simultaneous editors', () => {
  const { props, container, rerender } = setup();
  rerender(<><ProfileFields {...props} limits={undefined} /><ProfileFields {...props} limits={undefined} /></>);
  const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(screen.getAllByRole('textbox', { name: ETIQUETAS.purpose.titulo })).toHaveLength(2);
  expect(screen.getAllByText('0 / —')).toHaveLength(6);
});
