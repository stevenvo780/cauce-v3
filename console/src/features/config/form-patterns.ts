// Browsers compile `pattern` with the `v` flag, where a bare `-` in a class silently drops the validation: escape every `-`.
export const COMPANY_SLUG_PATTERN = '[a-z][a-z0-9\\-]{1,62}';
export const AGENT_ALIAS_PATTERN = '[a-z][a-z0-9_\\-]{0,63}';
export const HOST_ID_PATTERN = '[a-z][a-z0-9_\\-]{0,63}';

// Company ids (lowercase letters, digits, dashes) are valid as-is outside a class.
export function companyHostIdPattern(company: string): string {
  return `${company}-[a-z0-9_]+`;
}
