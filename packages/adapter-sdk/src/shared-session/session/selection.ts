function words(command: string): string[] | undefined {
  const tokens: string[] = []; let token = ''; let quoted: string | undefined; let active = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === undefined) return undefined;
    if (quoted === "'") { if (char === "'") quoted = undefined; else token += char; continue; }
    if (char === '\\') {
      const next = command[index + 1]; if (next === undefined || /[\r\n]/u.test(next)) return undefined;
      if (quoted === '"' && !['$', '`', '"', '\\'].includes(next)) { token += char; continue; }
      index++; token += next; active = true; continue;
    }
    if (quoted === '"') { if (char === '"') quoted = undefined; else if (/[$`]/u.test(char)) return undefined; else token += char; continue; }
    if (char === "'" || char === '"') { quoted = char; active = true; continue; }
    if (char === ' ' || char === '\t') { if (active) tokens.push(token); token = ''; active = false; continue; }
    if (/[;&|()<>\r\n$`#*?[\]{}~]/u.test(char)) return undefined;
    token += char; active = true;
  }
  if (quoted !== undefined) return undefined;
  if (active) tokens.push(token);
  return tokens;
}

interface PaneInvocation { argv: string[]; environment: Map<string, string>; unset: Set<string> }

function invocation(command: string, depth = 0): PaneInvocation | undefined {
  if (depth > 2) return undefined;
  const tokens = words(command); if (tokens === undefined) return undefined;
  let start = 0;
  const environment = new Map<string, string>(); const unset = new Set<string>();
  if (tokens[start] === 'exec') { start++; if (tokens[start] === '--') start++; }
  if (['env', '/usr/bin/env', '/bin/env'].includes(tokens[start] ?? '')) {
    start++;
    while (tokens[start] === '-u') {
      const name = tokens[start + 1]; if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
      unset.add(name); start += 2;
    }
    if (tokens[start] === '--') start++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[start] ?? '')) {
      const assignment = tokens[start]; if (assignment === undefined) return undefined;
      const equal = assignment.indexOf('='); const name = assignment.slice(0, equal);
      if (environment.has(name)) return undefined;
      environment.set(name, assignment.slice(equal + 1)); unset.delete(name); start++;
    }
  }
  const executable = tokens[start]; if (executable === undefined || executable.startsWith('-')) return undefined;
  if (['bash', 'sh', '/bin/bash', '/bin/sh', '/usr/bin/bash', '/usr/bin/sh'].includes(executable)) {
    const body = tokens[start + 2];
    if (!['-c', '-lc'].includes(tokens[start + 1] ?? '') || tokens.length !== start + 3 || body === undefined) return undefined;
    const nested = invocation(body, depth + 1); if (nested === undefined) return undefined;
    for (const name of nested.unset) { environment.delete(name); unset.add(name); }
    for (const [name, value] of nested.environment) { environment.set(name, value); unset.delete(name); }
    return { argv: nested.argv, environment, unset };
  }
  return { argv: tokens.slice(start), environment, unset };
}

export function selectedPaneEnvironmentMatch(command: string, expected: Readonly<Record<string, string>> | undefined, absent: readonly string[] = []): boolean {
  if (expected === undefined && absent.length === 0) return true;
  const observed = invocation(command); if (observed === undefined) return false;
  return Object.entries(expected ?? {}).every(([name, value]) => observed.environment.get(name) === value)
    && absent.every(name => observed.unset.has(name) && !observed.environment.has(name));
}

export function selectedPaneArgumentsMatch(command: string, pinnedCommand?: string, required: readonly string[] = []): boolean {
  if (pinnedCommand === undefined && required.length === 0) return true;
  const observed = invocation(command)?.argv; if (observed === undefined) return false;
  if (pinnedCommand !== undefined && observed[0] !== pinnedCommand) return false;
  if (required.length === 0) return true;
  const end = observed.indexOf('--'); const args = observed.slice(1, end < 0 ? undefined : end);
  if (!args.some((_word, index) => required.every((word, offset) => args[index + offset] === word))) return false;
  if (required.includes('--model') && args.filter(word => /^(?:--model(?:=|$)|-m$|model=)/u.test(word)).length !== 1) return false;
  if (required.includes('--effort') && args.filter(word => /^--effort(?:=|$)/u.test(word)).length !== 1) return false;
  if (required.includes('--reasoning-effort') && args.filter(word => /^(?:--reasoning-effort|--effort|--thinking)(?:=|$)/u.test(word)).length !== 1) return false;
  if (required.some(word => word.startsWith('model_reasoning_effort='))
      && args.filter(word => word.startsWith('model_reasoning_effort=')).length !== 1) return false;
  return true;
}
