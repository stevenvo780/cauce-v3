import { createInterface } from 'node:readline';
import { createPool } from '@cauce/store';
import { normalizeEmail } from './console-users.js';
import { assertPasswordPolicy, hashPassword } from './password.js';

/**
 * CLI to provision, change password and deactivate console users.
 *
 *   pnpm console:user --email user@example.com --name "User" --role operator --alias kant
 *   pnpm console:user --email user@example.com --deactivate
 */

interface Options {
  email: string;
  name: string;
  role: 'operator' | 'reader';
  tenant: string;
  alias: string;
  deactivate: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let deactivate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--deactivate') {
      deactivate = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`argumento inesperado: ${argument}`);
    const separator = argument.indexOf('=');
    if (separator > 0) {
      values.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`falta el valor de ${argument}`);
    values.set(argument.slice(2), next);
    index += 1;
  }
  if (values.has('password')) {
    throw new Error('la contraseña no se pasa por argumento: usá CAUCE_CONSOLE_USER_PASSWORD o el prompt');
  }
  const email = (values.get('email') ?? '').trim();
  if (email.length < 3 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('--email es obligatorio y debe ser un correo');
  const role = values.get('role') ?? 'operator';
  if (role !== 'operator' && role !== 'reader') throw new Error('--role debe ser operator o reader');
  const alias = values.get('alias') ?? 'kant';
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(alias)) throw new Error('--alias inválido');
  return {
    email,
    name: (values.get('name') ?? email.split('@')[0]!).trim(),
    role,
    // Default Cauce identity for the console.
    tenant: values.get('tenant') ?? 'Steven',
    alias,
    deactivate
  };
}

/** Prompt without echo. Fails if there is no TTY: asking a pipe for a password would leave it in a log. */
async function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('sin TTY: pasá la contraseña en CAUCE_CONSOLE_USER_PASSWORD');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = process.stdout;
  const original = output.write.bind(output);
  process.stdout.write(`${label}: `);
  // Echo is disabled by writing nothing while readline "repeats" what is being typed.
  (output as unknown as { write: (chunk: string) => boolean }).write = () => true;
  try {
    return await new Promise<string>((resolve) => { rl.question('', resolve); });
  } finally {
    (output as unknown as { write: typeof original }).write = original;
    rl.close();
    process.stdout.write('\n');
  }
}

async function readPassword(): Promise<string> {
  const fromEnvironment = process.env.CAUCE_CONSOLE_USER_PASSWORD;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  const first = await promptPassword('Contraseña nueva');
  const second = await promptPassword('Repetila');
  if (first !== second) throw new Error('las contraseñas no coinciden');
  return first;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const options = parseArguments(process.argv.slice(2));
const pool = createPool(databaseUrl, { max: 2, applicationName: 'cauce-console-user' });

try {
  if (options.deactivate) {
    const result = await pool.query(
      `UPDATE console_users SET active=false, updated_at=CURRENT_TIMESTAMP
        WHERE email_normalized=$1 RETURNING email, active`,
      [normalizeEmail(options.email)]
    );
    if (result.rowCount !== 1) throw new Error(`no existe una cuenta de consola para ${options.email}`);
    console.log(`cuenta desactivada: ${options.email}`);
    console.log('las sesiones abiertas dejan de valer en el próximo request: el gateway relee la fila.');
  } else {
    const password = await readPassword();
    assertPasswordPolicy(password);
    const passwordHash = await hashPassword(password);
    const result = await pool.query<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO console_users
         (email, email_normalized, password_hash, display_name, role, tenant_id, alias, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (email_normalized) DO UPDATE SET
         email=EXCLUDED.email,
         password_hash=EXCLUDED.password_hash,
         display_name=EXCLUDED.display_name,
         role=EXCLUDED.role,
         tenant_id=EXCLUDED.tenant_id,
         alias=EXCLUDED.alias,
         active=true,
         password_changed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
       RETURNING id, created_at, updated_at`,
      [
        options.email, normalizeEmail(options.email), passwordHash,
        options.name, options.role, options.tenant, options.alias
      ]
    );
    const row = result.rows[0]!;
    const created = row.created_at.getTime() === row.updated_at.getTime();
    console.log(`${created ? 'cuenta creada' : 'cuenta actualizada'}: ${options.email}`);
    console.log(`  id      ${row.id}`);
    console.log(`  rol     ${options.role}`);
    console.log(`  actúa   ${options.tenant}:${options.alias}`);
    if (!created) console.log('  las sesiones abiertas con la contraseña anterior quedaron invalidadas.');
  }
} finally {
  await pool.end();
}
