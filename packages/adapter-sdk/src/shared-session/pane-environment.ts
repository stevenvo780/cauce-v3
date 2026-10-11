export function paneEnvironmentPrefix(
  environment: Readonly<Record<string, string>> | undefined,
  unset: readonly string[] = [],
): { ok: true; prefix: string } | { ok: false; detail: string } {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0 && unset.length === 0) return { ok: true, prefix: "" };
  const parts: string[] = [];
  for (const name of unset) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || Object.hasOwn(environment ?? {}, name)) return { ok: false, detail: 'invalid shared session environment removal' };
    parts.push(`-u ${name}`);
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return { ok: false, detail: `nombre de variable inválido para la sesión compartida: ${name}` };
    }
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return { ok: true, prefix: `env ${parts.join(" ")} ` };
}

/** Single quotes, which on POSIX interpret NOTHING. The value never touches the shell parser. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
