import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig, parseSchool, parseSsoOrigins } from '../src/config.js';
import { PublicError } from '../src/errors.js';

const hostileSchools = [
  'example.org/#',
  'mencia.magister.net.evil.example',
  'accounts.magister.net@evil.example',
  'mencia.magister.net:444',
  'mencia.magister.net/path',
  'mencia.magister.net?x=1',
  'mencia.magister.net#fragment',
  'http://mencia.magister.net',
  'mencia\\evil.example',
  '../mencia',
  '-mencia',
  'mencia..magister.net',
];

const extraHostileSchools = [
  '',
  'accounts',
  'accounts.magister.net',
  'https://accounts.magister.net/',
  'xn--mncia-bsa',
  'xn--mncia-bsa.magister.net',
  'méncia',
  'mencia-',
  'a'.repeat(64),
  'https://mencia',
  'https://mencia.magister.net/path',
  'https://mencia.magister.net//',
  'https://user@mencia.magister.net/',
  'https://mencia.magister.net:443/',
  'https://mencia.magister.net/?x',
  'https://mencia.magister.net/#x',
  'HTTPS://mencia.magister.net/ ',
  ' mencia',
  'mencia.magister.net.',
  'mencia.evil.example',
  'mencia.magister.nl',
  '//mencia.magister.net',
  'javascript:alert(1)',
];

const PACKAGE_ROOT = '/opt/pkg/unofficial-magister-mcp';
const baseOptions = {
  platform: 'linux' as NodeJS.Platform,
  homedir: '/home/tester',
  tmpdir: '/tmp',
  packageRoot: PACKAGE_ROOT,
};

function expectConfigError(fn: () => unknown, variable: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PublicError, 'expected PublicError');
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.equal(error.variable, variable);
    return true;
  });
}

describe('parseSchool', () => {
  for (const input of [...hostileSchools, ...extraHostileSchools]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expectConfigError(() => parseSchool(input), 'MAGISTER_SCHOOL');
    });
  }

  for (const input of [
    'mencia',
    'mencia.magister.net',
    'https://mencia.magister.net',
    'https://mencia.magister.net/',
    'MENCIA',
    'Mencia.Magister.Net',
    'HTTPS://MENCIA.MAGISTER.NET/',
  ]) {
    it(`accepts ${JSON.stringify(input)} as the canonical origin`, () => {
      const origin = parseSchool(input);
      assert.equal(origin, 'https://mencia.magister.net');
      assert.equal(new URL(origin).origin, 'https://mencia.magister.net');
    });
  }

  it('accepts labels with inner hyphens and digits', () => {
    assert.equal(parseSchool('st-joris2'), 'https://st-joris2.magister.net');
  });
});

describe('parseSsoOrigins', () => {
  it('returns an empty list for an absent value', () => {
    assert.deepEqual(parseSsoOrigins(undefined), []);
    assert.deepEqual(parseSsoOrigins(''), []);
  });

  it('accepts exact https origins', () => {
    assert.deepEqual(
      parseSsoOrigins('https://login.microsoftonline.com, https://sso.example.org'),
      ['https://login.microsoftonline.com', 'https://sso.example.org']
    );
  });

  for (const input of [
    'http://sso.example.org',
    'https://sso.example.org/',
    'https://sso.example.org/path',
    'https://sso.example.org:8443',
    'https://*.example.org',
    'https://user@sso.example.org',
    'sso.example.org',
    'https://sso.example.org?x=1',
    'https://sso.example.org#x',
    'https://localhost',
    'https://SSO.example.org',
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expectConfigError(() => parseSsoOrigins(input), 'MAGISTER_SSO_ORIGINS');
    });
  }
});

describe('loadConfig', () => {
  it('defaults to interactive mode without requiring a password', () => {
    const config = loadConfig({ MAGISTER_SCHOOL: 'mencia' }, baseOptions);
    assert.equal(config.schoolOrigin, 'https://mencia.magister.net');
    assert.equal(config.authMode, 'interactive');
    assert.equal(config.profile, 'default');
    assert.equal(config.password, undefined);
    assert.equal(config.persistSession, true);
    assert.equal(config.stateDir, '/home/tester/.local/state/unofficial-magister-mcp');
    assert.equal(config.sessionMaxAgeMs, 30 * 24 * 60 * 60 * 1000);
    assert.equal(config.debug, false);
  });

  it('does not keep the password in interactive mode', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', MAGISTER_USER: 'u', MAGISTER_PASS: 'secret' },
      baseOptions
    );
    assert.equal(config.password, undefined);
    assert.equal(config.profile, 'u');
  });

  it('requires MAGISTER_SCHOOL', () => {
    expectConfigError(() => loadConfig({}, baseOptions), 'MAGISTER_SCHOOL');
  });

  it('requires MAGISTER_PASS in password mode', () => {
    expectConfigError(
      () =>
        loadConfig(
          { MAGISTER_SCHOOL: 'mencia', MAGISTER_AUTH_MODE: 'password', MAGISTER_USER: 'u' },
          baseOptions
        ),
      'MAGISTER_PASS'
    );
  });

  it('requires MAGISTER_USER in password mode', () => {
    expectConfigError(
      () =>
        loadConfig(
          { MAGISTER_SCHOOL: 'mencia', MAGISTER_AUTH_MODE: 'password', MAGISTER_PASS: 'p' },
          baseOptions
        ),
      'MAGISTER_USER'
    );
  });

  it('accepts password mode with both credentials', () => {
    const config = loadConfig(
      {
        MAGISTER_SCHOOL: 'mencia',
        MAGISTER_AUTH_MODE: 'password',
        MAGISTER_USER: 'u',
        MAGISTER_PASS: 'p',
      },
      baseOptions
    );
    assert.equal(config.authMode, 'password');
    assert.equal(config.username, 'u');
    assert.equal(config.password, 'p');
  });

  it('rejects an unknown auth mode', () => {
    expectConfigError(
      () => loadConfig({ MAGISTER_SCHOOL: 'mencia', MAGISTER_AUTH_MODE: 'magic' }, baseOptions),
      'MAGISTER_AUTH_MODE'
    );
  });

  it('prefers MAGISTER_PROFILE over MAGISTER_USER', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', MAGISTER_PROFILE: 'kid-a', MAGISTER_USER: 'u' },
      baseOptions
    );
    assert.equal(config.profile, 'kid-a');
  });

  it('uses Application Support on macOS', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia' },
      { ...baseOptions, platform: 'darwin', homedir: '/Users/tester' }
    );
    assert.equal(
      config.stateDir,
      '/Users/tester/Library/Application Support/unofficial-magister-mcp'
    );
  });

  it('uses XDG_STATE_HOME on Linux when set', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', XDG_STATE_HOME: '/srv/state' },
      baseOptions
    );
    assert.equal(config.stateDir, '/srv/state/unofficial-magister-mcp');
  });

  it('accepts an absolute MAGISTER_STATE_DIR outside the package', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', MAGISTER_STATE_DIR: '/tmp/private-test-dir' },
      baseOptions
    );
    assert.equal(config.stateDir, '/tmp/private-test-dir');
  });

  for (const dir of [
    'relative/state',
    PACKAGE_ROOT,
    join(PACKAGE_ROOT, 'state'),
    join(PACKAGE_ROOT, 'a', '..', 'b'),
    '/tmp',
    '/tmp/',
    '/private/tmp',
    '/var/tmp',
  ]) {
    it(`rejects MAGISTER_STATE_DIR=${dir}`, () => {
      expectConfigError(
        () => loadConfig({ MAGISTER_SCHOOL: 'mencia', MAGISTER_STATE_DIR: dir }, baseOptions),
        'MAGISTER_STATE_DIR'
      );
    });
  }

  it('parses MAGISTER_PERSIST_SESSION strictly', () => {
    for (const [value, expected] of [
      ['false', false],
      ['0', false],
      ['true', true],
      ['1', true],
    ] as const) {
      const config = loadConfig(
        { MAGISTER_SCHOOL: 'mencia', MAGISTER_PERSIST_SESSION: value },
        baseOptions
      );
      assert.equal(config.persistSession, expected);
    }
    expectConfigError(
      () => loadConfig({ MAGISTER_SCHOOL: 'mencia', MAGISTER_PERSIST_SESSION: 'yes' }, baseOptions),
      'MAGISTER_PERSIST_SESSION'
    );
  });

  it('parses MAGISTER_CHILD_ID as a positive integer', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', MAGISTER_CHILD_ID: '1234' },
      baseOptions
    );
    assert.equal(config.childId, 1234);
    for (const bad of ['0', '-1', '1.5', 'abc', '01']) {
      expectConfigError(
        () => loadConfig({ MAGISTER_SCHOOL: 'mencia', MAGISTER_CHILD_ID: bad }, baseOptions),
        'MAGISTER_CHILD_ID'
      );
    }
  });

  it('parses MAGISTER_SESSION_MAX_AGE_DAYS within bounds', () => {
    const config = loadConfig(
      { MAGISTER_SCHOOL: 'mencia', MAGISTER_SESSION_MAX_AGE_DAYS: '7' },
      baseOptions
    );
    assert.equal(config.sessionMaxAgeMs, 7 * 24 * 60 * 60 * 1000);
    for (const bad of ['0', '366', 'x', '1.5']) {
      expectConfigError(
        () =>
          loadConfig(
            { MAGISTER_SCHOOL: 'mencia', MAGISTER_SESSION_MAX_AGE_DAYS: bad },
            baseOptions
          ),
        'MAGISTER_SESSION_MAX_AGE_DAYS'
      );
    }
  });

  it('enables debug only for explicit values', () => {
    assert.equal(
      loadConfig({ MAGISTER_SCHOOL: 'm', MAGISTER_DEBUG: '1' }, baseOptions).debug,
      true
    );
    assert.equal(
      loadConfig({ MAGISTER_SCHOOL: 'm', MAGISTER_DEBUG: '' }, baseOptions).debug,
      false
    );
  });

  it('never includes the rejected value in the error', () => {
    try {
      loadConfig({ MAGISTER_SCHOOL: 'secret-sentinel.evil.example' }, baseOptions);
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof PublicError);
      assert.equal(String(error.message).includes('secret-sentinel'), false);
      assert.equal(JSON.stringify(error).includes('secret-sentinel'), false);
    }
  });
});
