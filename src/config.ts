import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicError } from './errors.js';
import { AUTH_ORIGIN } from './security.js';

export type AuthMode = 'interactive' | 'password';

export interface Config {
  /** Canonical school origin, e.g. https://mencia.magister.net */
  readonly schoolOrigin: string;
  /** Local profile name; only ever used hashed to scope stored sessions. */
  readonly profile: string;
  readonly authMode: AuthMode;
  /** Only set in password mode. */
  readonly username: string | undefined;
  /** Only set in password mode. */
  readonly password: string | undefined;
  readonly stateDir: string;
  readonly persistSession: boolean;
  readonly childId: number | undefined;
  readonly ssoOrigins: readonly string[];
  readonly sessionMaxAgeMs: number;
  readonly debug: boolean;
}

export interface ConfigOptions {
  platform: NodeJS.Platform;
  homedir: string;
  tmpdir: string;
  packageRoot: string;
}

export const APP_DIR_NAME = 'unofficial-magister-mcp';
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_AGE_DAYS = 30;
const SCHOOL_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAGISTER_SUFFIX = '.magister.net';
const SHARED_TMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

export function defaultConfigOptions(): ConfigOptions {
  return {
    platform: process.platform,
    homedir: homedir(),
    tmpdir: tmpdir(),
    packageRoot: PACKAGE_ROOT,
  };
}

/**
 * Normalises the school setting to one canonical origin. Accepts a bare label,
 * `<label>.magister.net` or `https://<label>.magister.net[/]`; everything else
 * (paths, ports, userinfo, other hosts, punycode) is rejected.
 */
export function parseSchool(input: string): string {
  const fail = () => new PublicError('CONFIG_INVALID', 'MAGISTER_SCHOOL');
  let host = input.toLowerCase();
  let hadScheme = false;
  if (host.startsWith('https://')) {
    hadScheme = true;
    host = host.slice('https://'.length);
    if (host.endsWith('/')) host = host.slice(0, -1);
  }
  let label: string;
  if (host.endsWith(MAGISTER_SUFFIX)) {
    label = host.slice(0, -MAGISTER_SUFFIX.length);
  } else if (hadScheme) {
    throw fail();
  } else {
    label = host;
  }
  if (!SCHOOL_LABEL.test(label) || label.startsWith('xn--')) {
    throw fail();
  }
  const canonical = `https://${label}${MAGISTER_SUFFIX}`;
  const url = new URL(canonical);
  if (
    url.origin !== canonical ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    canonical === AUTH_ORIGIN
  ) {
    throw fail();
  }
  return canonical;
}

/** Parses a comma-separated list of exact HTTPS origins (no path, port or wildcard). */
export function parseSsoOrigins(input: string | undefined): string[] {
  if (input === undefined || input.trim() === '') return [];
  return input.split(',').map((raw) => {
    const item = raw.trim();
    const fail = () => new PublicError('CONFIG_INVALID', 'MAGISTER_SSO_ORIGINS');
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw fail();
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== item ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      !url.hostname.includes('.') ||
      item.includes('*')
    ) {
      throw fail();
    }
    return item;
  });
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  variable: 'MAGISTER_PERSIST_SESSION'
): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new PublicError('CONFIG_INVALID', variable);
}

function parsePositiveInt(value: string, max: number): number | null {
  if (!/^[1-9]\d{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function defaultStateDir(env: NodeJS.ProcessEnv, options: ConfigOptions): string {
  if (options.platform === 'darwin') {
    return join(options.homedir, 'Library', 'Application Support', APP_DIR_NAME);
  }
  if (options.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(options.homedir, 'AppData', 'Local');
    return join(base, APP_DIR_NAME);
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(options.homedir, '.local', 'state');
  return join(base, APP_DIR_NAME);
}

function parseStateDir(env: NodeJS.ProcessEnv, options: ConfigOptions): string {
  const raw = env.MAGISTER_STATE_DIR;
  if (raw === undefined || raw === '') return defaultStateDir(env, options);
  const fail = () => new PublicError('CONFIG_INVALID', 'MAGISTER_STATE_DIR');
  if (!isAbsolute(raw)) throw fail();
  const dir = resolve(raw);
  const sharedTmp = [...SHARED_TMP_DIRS, resolve(options.tmpdir)];
  if (sharedTmp.some((tmp) => dir === tmp || dir + sep === tmp)) throw fail();
  if (isInside(resolve(options.packageRoot), dir)) throw fail();
  return dir;
}

/** Loads and validates configuration once at startup. Throws PublicError(CONFIG_INVALID). */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: ConfigOptions = defaultConfigOptions()
): Config {
  const school = env.MAGISTER_SCHOOL;
  if (!school) throw new PublicError('CONFIG_INVALID', 'MAGISTER_SCHOOL');
  const schoolOrigin = parseSchool(school);

  const authModeRaw = env.MAGISTER_AUTH_MODE || 'interactive';
  if (authModeRaw !== 'interactive' && authModeRaw !== 'password') {
    throw new PublicError('CONFIG_INVALID', 'MAGISTER_AUTH_MODE');
  }
  const authMode: AuthMode = authModeRaw;

  let username: string | undefined;
  let password: string | undefined;
  if (authMode === 'password') {
    if (!env.MAGISTER_USER) throw new PublicError('CONFIG_INVALID', 'MAGISTER_USER');
    if (!env.MAGISTER_PASS) throw new PublicError('CONFIG_INVALID', 'MAGISTER_PASS');
    username = env.MAGISTER_USER;
    password = env.MAGISTER_PASS;
  }

  const profile = env.MAGISTER_PROFILE || env.MAGISTER_USER || 'default';
  if (profile.length > 256) throw new PublicError('CONFIG_INVALID', 'MAGISTER_PROFILE');

  let childId: number | undefined;
  if (env.MAGISTER_CHILD_ID) {
    const parsed = parsePositiveInt(env.MAGISTER_CHILD_ID, Number.MAX_SAFE_INTEGER);
    if (parsed === null) throw new PublicError('CONFIG_INVALID', 'MAGISTER_CHILD_ID');
    childId = parsed;
  }

  let sessionMaxAgeDays = DEFAULT_SESSION_MAX_AGE_DAYS;
  if (env.MAGISTER_SESSION_MAX_AGE_DAYS) {
    const parsed = parsePositiveInt(env.MAGISTER_SESSION_MAX_AGE_DAYS, 365);
    if (parsed === null) throw new PublicError('CONFIG_INVALID', 'MAGISTER_SESSION_MAX_AGE_DAYS');
    sessionMaxAgeDays = parsed;
  }

  return {
    schoolOrigin,
    profile,
    authMode,
    username,
    password,
    stateDir: parseStateDir(env, options),
    persistSession: parseBoolean(env.MAGISTER_PERSIST_SESSION, true, 'MAGISTER_PERSIST_SESSION'),
    childId,
    ssoOrigins: parseSsoOrigins(env.MAGISTER_SSO_ORIGINS),
    sessionMaxAgeMs: sessionMaxAgeDays * DAY_MS,
    debug: env.MAGISTER_DEBUG === '1' || env.MAGISTER_DEBUG === 'true',
  };
}
