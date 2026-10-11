export interface PlatformCliArguments {
  command: 'show' | 'change' | 'rollback' | 'export' | 'plan-import' | 'import';
  email: string; companyId: string; databaseUrlFile: string; dryRun: boolean;
  expectedRevision?: number; revision?: number; mutationFile?: string; bundleFile?: string; planFile?: string; output?: string;
}
function integer(value: string | undefined, name: string, minimum = 0): number {
  const number = value === undefined || value.trim() === '' ? NaN : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} debe ser un entero >= ${String(minimum)}`);
  return number;
}
export function parsePlatformCliArguments(argv: readonly string[]): PlatformCliArguments {
  const [command, ...rest] = argv;
  if (!['show', 'change', 'rollback', 'export', 'plan-import', 'import'].includes(command ?? '')) throw new Error('comando de plataforma inválido');
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument?.startsWith('--')) throw new Error('argumento de plataforma inválido');
    if (argument === '--apply' || argument === '--dry-run') {
      if (flags.has(argument)) throw new Error('opción duplicada'); flags.add(argument); continue;
    }
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator > 0 ? separator : undefined);
    if (name === 'password' || name === 'role' || name === 'database-url') throw new Error('contraseña, rol y URL no se pasan por argumentos');
    if (values.has(name)) throw new Error('opción duplicada');
    const value = separator > 0 ? argument.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error('falta un valor de plataforma');
    values.set(name, value);
  }
  const shared = ['email', 'company', 'database-url-file'];
  const extra: Record<string, string[]> = { show: [], change: ['mutation-file', 'expected-revision'], rollback: ['revision', 'expected-revision'],
    export: ['output'], 'plan-import': ['bundle-file', 'expected-revision', 'output'], import: ['bundle-file', 'plan-file'] };
  const expected = extra[command ?? ''] ?? [];
  if ([...values.keys()].some(name => ![...shared, ...expected].includes(name))) throw new Error('opción no admitida para el comando');
  for (const name of [...shared, ...expected]) if (!values.get(name)?.trim()) throw new Error(`--${name} es obligatorio`);
  const write = command === 'change' || command === 'rollback' || command === 'import';
  if ((write && flags.size !== 1) || (!write && flags.size !== 0)) throw new Error('la escritura exige exactamente --dry-run o --apply');
  const email = values.get('email') ?? ''; const companyId = values.get('company') ?? '';
  if (!/^[^\s@]+@[^\s@]+$/u.test(email) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(companyId)) throw new Error('correo o empresa inválidos');
  return {
    command: command as PlatformCliArguments['command'], email, companyId, databaseUrlFile: values.get('database-url-file') ?? '',
    dryRun: flags.has('--dry-run'),
    ...(values.has('expected-revision') ? { expectedRevision: integer(values.get('expected-revision'), '--expected-revision') } : {}),
    ...(values.has('revision') ? { revision: integer(values.get('revision'), '--revision', 1) } : {}),
    ...(values.has('mutation-file') ? { mutationFile: values.get('mutation-file') ?? '' } : {}),
    ...(values.has('bundle-file') ? { bundleFile: values.get('bundle-file') ?? '' } : {}),
    ...(values.has('plan-file') ? { planFile: values.get('plan-file') ?? '' } : {}),
    ...(values.has('output') ? { output: values.get('output') ?? '' } : {}),
  };
}
