import { describe, expect, it } from 'vitest';
import { parsePlatformCliArguments } from './platform-cli-arguments.js';

const identity = ['--email', 'operator@example.test', '--company', 'praxis', '--database-url-file', '/private/owner-dsn'];
describe('platform CLI explicit authority inputs', () => {
  it('requires the acting company, email and an explicit database URL file', () => {
    expect(parsePlatformCliArguments(['show', ...identity])).toMatchObject({ command: 'show', companyId: 'praxis', databaseUrlFile: '/private/owner-dsn' });
    for (const name of ['--email', '--company', '--database-url-file']) {
      const index = identity.indexOf(name);
      expect(() => parsePlatformCliArguments(['show', ...identity.slice(0, index), ...identity.slice(index + 2)])).toThrow('obligatorio');
    }
  });
  it('rejects password, role and database URLs in arguments, including equals syntax', () => {
    for (const argument of ['--password=secret', '--role=platform_admin', '--database-url=postgres://owner']) {
      expect(() => parsePlatformCliArguments(['show', ...identity, argument])).toThrow('no se pasan');
    }
  });
  it('requires exactly one explicit mutation mode and a numeric CAS revision', () => {
    const argv = ['change', ...identity, '--mutation-file', '/private/change', '--expected-revision', '4'];
    expect(parsePlatformCliArguments([...argv, '--dry-run'])).toMatchObject({ expectedRevision: 4, dryRun: true });
    expect(parsePlatformCliArguments([...argv, '--apply'])).toMatchObject({ dryRun: false });
    for (const flags of [[], ['--apply', '--dry-run'], ['--apply', '--apply']]) expect(() => parsePlatformCliArguments([...argv, ...flags])).toThrow();
    expect(() => parsePlatformCliArguments([...argv.slice(0, -1), 'NaN', '--apply'])).toThrow('entero');
  });
  it('rejects irrelevant, duplicate, missing and unknown command options', () => {
    for (const argv of [['show', ...identity, '--revision', '1'], ['show', ...identity, '--email=x@y.test'],
      ['show', ...identity, '--dry-run'], ['import', ...identity, '--apply'], ['update', ...identity]]) {
      expect(() => parsePlatformCliArguments(argv)).toThrow();
    }
  });
  it('binds a private plan to import instead of accepting a new revision flag', () => {
    expect(parsePlatformCliArguments(['import', ...identity, '--bundle-file=/private/bundle', '--plan-file=/private/plan', '--apply']))
      .toMatchObject({ command: 'import', bundleFile: '/private/bundle', planFile: '/private/plan', dryRun: false });
  });
});
