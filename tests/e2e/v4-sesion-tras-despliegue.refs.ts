export const SESSION_RELEASE_A = 'f6e02fdba802ed2d487c855c5840ac706a83d4d2';
export const SESSION_BASELINE = '53d788c4c342a2c8852ef535c55a879a86c218c6';
export const SESSION_AUTO_BASELINE = 'f46a2b8ba254c6a6ca5cfd5e5a08ae838e5d3224';

export function automaticSessionReleaseSource(): { reference: string; workingTree: boolean; baseline: boolean } {
  const source = process.env.H13_AUTO_B_SOURCE;
  if (source === undefined) return { reference: 'HEAD', workingTree: true, baseline: false };
  if (source === 'baseline') return { reference: SESSION_AUTO_BASELINE, workingTree: false, baseline: true };
  if (/^[a-f0-9]{40}$/u.test(source)) return { reference: source, workingTree: false, baseline: false };
  throw new Error('the automatic release source is unsupported');
}
