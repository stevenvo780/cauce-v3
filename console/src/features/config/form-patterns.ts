/**
 * HTML `pattern` values. Browsers compile them with the `v` flag, where a bare `-` inside a character
 * class is a syntax error and the whole validation is silently dropped, so every `-` is escaped.
 */
export const COMPANY_SLUG_PATTERN = '[a-z][a-z0-9\\-]{1,62}';
export const AGENT_ALIAS_PATTERN = '[a-z][a-z0-9_\\-]{0,63}';
export const HOST_ID_PATTERN = '[a-z][a-z0-9_\\-]{0,63}';

/** A company invites computers only as `<company>-<name>`; company ids are lowercase letters, digits and dashes, valid as-is outside a class. */
export function companyHostIdPattern(company: string): string {
  return `${company}-[a-z0-9_]+`;
}
