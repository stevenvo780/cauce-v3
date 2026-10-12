import { COMPANY_ID_PATTERN } from '@cauce/store';

/** The console form `pattern` language: narrower than a stored company id (no `_`, at least two characters). */
export const COMPANY_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/u;

/** Names of the platform, its routes and common infrastructure hosts; public registration never hands them out. */
export const RESERVED_COMPANY_SLUGS: readonly string[] = Object.freeze([
  'abuse', 'admin', 'administrador', 'administrator', 'api', 'app', 'auth', 'billing', 'cauce', 'consola', 'console',
  'dashboard', 'default', 'docs', 'help', 'hostmaster', 'hub', 'login', 'mail', 'null', 'office', 'operator',
  'platform', 'plataforma', 'postmaster', 'register', 'registro', 'root', 'security', 'sistema', 'soporte', 'staff',
  'status', 'support', 'system', 'undefined', 'webmaster', 'www',
]);

/** Company names are data: the operator holds back slugs of companies the platform will create in `CAUCE_RESERVED_COMPANY_SLUGS`. */
export function configuredReservedCompanySlugs(value = process.env.CAUCE_RESERVED_COMPANY_SLUGS ?? ''): ReadonlySet<string> {
  const configured = value.split(',').map(slug => slug.trim()).filter(slug => slug !== '');
  if (configured.some(slug => !COMPANY_ID_PATTERN.test(slug))) {
    throw new Error('CAUCE_RESERVED_COMPANY_SLUGS must list lowercase company identifiers separated by commas');
  }
  return new Set([...RESERVED_COMPANY_SLUGS, ...configured]);
}
