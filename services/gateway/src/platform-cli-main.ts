import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { createPool } from '@cauce/store';
import { configuredFleetRepository } from './fleet/gateway-config.js';
import { runPlatformCli, type PlatformCliCommand } from './platform-cli.js';
import { parsePlatformCliArguments, type PlatformCliArguments } from './platform-cli-arguments.js';

async function privateText(path: string, limit: number): Promise<string> {
  if (!isAbsolute(path)) throw new Error('los archivos deben tener ruta absoluta');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat();
    if (!state.isFile() || state.size > limit || (state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()) {
      throw new Error('el archivo debe ser privado, regular y del usuario actual');
    }
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > limit) throw new Error('el archivo supera el límite');
    return text;
  } finally { await file.close(); }
}
async function json(path: string | undefined): Promise<unknown> {
  if (path === undefined) throw new Error('falta un archivo');
  return JSON.parse(await privateText(path, 32 * 1024 * 1024)) as unknown;
}
async function password(): Promise<string> {
  const environment = process.env.CAUCE_PLATFORM_PASSWORD;
  delete process.env.CAUCE_PLATFORM_PASSWORD;
  if (environment !== undefined && environment.length > 0) return environment;
  if (!process.stdin.isTTY) throw new Error('sin TTY, usa CAUCE_PLATFORM_PASSWORD');
  const output = process.stdout; const original = output.write.bind(output);
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  output.write('Contraseña actual: ');
  (output as unknown as { write: (chunk: string) => boolean }).write = () => true;
  try { return await new Promise<string>(resolve => { prompt.question('', resolve); }); }
  finally { (output as unknown as { write: typeof original }).write = original; prompt.close(); output.write('\n'); }
}
async function command(options: PlatformCliArguments): Promise<PlatformCliCommand> {
  switch (options.command) {
    case 'show': case 'export': return { kind: options.command };
    case 'change': return { kind: 'change', mutation: await json(options.mutationFile), dryRun: options.dryRun, expectedRevision: options.expectedRevision ?? -1 };
    case 'rollback': return { kind: 'rollback', revision: options.revision ?? -1, dryRun: options.dryRun, expectedRevision: options.expectedRevision ?? -1 };
    case 'plan-import': return { kind: 'plan-import', bundle: await json(options.bundleFile), expectedRevision: options.expectedRevision ?? -1 };
    case 'import': return { kind: 'import', bundle: await json(options.bundleFile), plan: await json(options.planFile), dryRun: options.dryRun };
  }
}
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write('Uso: cauce platform <show|change|rollback|export|plan-import|import> --email EMAIL --company ID --database-url-file RUTA\n'
      + 'change: --mutation-file RUTA --expected-revision N --dry-run|--apply\n'
      + 'rollback: --revision N --expected-revision N --dry-run|--apply\n'
      + 'export: --output RUTA; plan-import: --bundle-file RUTA --expected-revision N --output RUTA\n'
      + 'import: --bundle-file RUTA --plan-file RUTA --dry-run|--apply\n'
      + 'Los archivos de entrada deben ser privados. La contraseña se solicita sin eco; sin TTY, usa CAUCE_PLATFORM_PASSWORD.\n');
    return;
  }
  const options = parsePlatformCliArguments(argv);
  const databaseUrl = (await privateText(options.databaseUrlFile, 16 * 1024)).trim();
  const request = await command(options);
  const currentPassword = await password();
  const pool = createPool(databaseUrl, { max: 2, applicationName: 'cauce-platform-cli' });
  try {
    const settings = request.kind === 'import' || request.kind === 'plan-import' ? { fleetRepository: await configuredFleetRepository(pool) } : {};
    const result = await runPlatformCli(pool, { email: options.email, password: currentPassword, companyId: options.companyId, command: request }, settings);
    const encoded = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output === undefined) { process.stdout.write(encoded); return; }
    if (!isAbsolute(options.output)) throw new Error('la salida debe tener ruta absoluta');
    const file = await open(options.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(encoded, 'utf8'); } finally { await file.close(); }
    process.stdout.write('Archivo privado creado.\n');
  } finally { await pool.end(); }
}
try { await main(); }
catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'platform_cli_failed';
  process.stderr.write(`La operación de plataforma falló (${/^[a-zA-Z0-9_-]{1,64}$/u.test(code) ? code : 'platform_cli_failed'}).\n`);
  process.exitCode = 1;
}
