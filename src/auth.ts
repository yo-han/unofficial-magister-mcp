import { randomUUID } from 'node:crypto';
import type { Page, Request, Route } from 'playwright';
import { BrowserSession, ClientDeps } from './browser-session.js';
import type { Config } from './config.js';
import { PublicError, PublicErrorCode } from './errors.js';
import { logEvent } from './logger.js';
import { AccountSchema, ChildrenSchema } from './magister-api.js';
import { AUTH_ORIGIN } from './security.js';
import type { StoredSession } from './storage.js';

/**
 * Authentication against Magister.
 *
 * The access token is only ever taken from the fragment of the OIDC callback
 * on the exact school origin, or from the `oidc.user:*` entry the school app
 * writes to sessionStorage. An id_token is never used as access token.
 */

/** Callback paths on the school origin that carry the token (verify live). */
export const CALLBACK_PATHS: readonly string[] = ['/oidc/redirect_callback.html'];
const AUTHORIZE_PATH = '/connect/authorize';
const POLL_MS = 100;

const CONTINUE_SELECTOR =
  'dna-button:has-text("Doorgaan"), button:has-text("Doorgaan"), [type="submit"]';
const PASSWORD_SELECTOR = '#password, input[type="password"]';
const CONSENT_SELECTORS = [
  'button:has-text("Accepteren")',
  'button:has-text("Accept")',
  'button:has-text("Akkoord")',
  '[id*="cookie"] button',
  '[class*="cookie"] button',
  '[class*="consent"] button',
];
const LOGIN_SELECTORS = [
  'dna-button:has-text("Inloggen")',
  'button:has-text("Inloggen")',
  'dna-button[type="submit"]',
  'button[type="submit"]',
  'input[type="submit"]',
];

export interface Identity {
  accountPersonId: number;
  /** Selected child of a parent account; undefined when the account itself is used. */
  childId: number | undefined;
}

export interface AcquiredToken {
  accessToken: string;
  accessTokenExp: number | null;
}

/** Reads `exp` (seconds) from a JWT payload without verifying it; only for scheduling. */
export function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const exp = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** The access token from a callback URL on the school origin, or null. */
export function tokenFromCallbackUrl(url: string, schoolOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== schoolOrigin || !CALLBACK_PATHS.includes(parsed.pathname)) return null;
  const token = new URLSearchParams(parsed.hash.slice(1)).get('access_token');
  return token && token.length > 0 ? token : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Watches the main frame for the callback; never looks at other frames or origins. */
class CallbackWatcher {
  token: string | null = null;
  callbackSeen = false;

  constructor(private readonly session: BrowserSession) {
    const page = session.page;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!isCallbackUrl(url, session.policy.schoolOrigin)) return;
      this.callbackSeen = true;
      this.token = tokenFromCallbackUrl(url, session.policy.schoolOrigin) ?? this.token;
    });
  }

  /** True once the page shows the school app (school origin, not the callback). */
  settled(): boolean {
    const url = this.session.page.url();
    return (
      this.session.policy.isSchoolOrigin(url) &&
      !isCallbackUrl(url, this.session.policy.schoolOrigin)
    );
  }
}

function isCallbackUrl(url: string, schoolOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === schoolOrigin && CALLBACK_PATHS.includes(parsed.pathname);
  } catch {
    return false;
  }
}

/** Fallback: the access_token of the school app's oidc.user entry. School origin only. */
async function tokenFromSessionStorage(session: BrowserSession): Promise<string | null> {
  if (!session.policy.isSchoolOrigin(session.page.url())) return null;
  try {
    return await session.guard.race(
      session.page.evaluate(() => {
        for (const key of Object.keys(sessionStorage)) {
          if (!key.startsWith('oidc.user:')) continue;
          try {
            const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
            if (value && typeof value.access_token === 'string' && value.access_token.length > 0) {
              return value.access_token as string;
            }
          } catch {
            // Not JSON; not an oidc user entry.
          }
        }
        return null;
      })
    );
  } catch (error) {
    if (error instanceof PublicError) throw error;
    // The page navigated while reading; try again on the next poll.
    return null;
  }
}

interface WaitOptions {
  timeoutMs: number;
  timeoutCode: PublicErrorCode;
  /** Checked on every poll; throw to stop waiting. */
  check?: () => void;
}

/**
 * Waits until a token was captured and the page shows the school app. A token
 * alone is not enough: the flow must also land on the school origin, so a
 * callback that continues to a foreign origin ends in ORIGIN_VIOLATION.
 */
async function waitForToken(
  session: BrowserSession,
  watcher: CallbackWatcher,
  options: WaitOptions
): Promise<AcquiredToken> {
  const deadline = Date.now() + options.timeoutMs;
  do {
    session.guard.assertTrusted();
    options.check?.();
    // The user closed the login window.
    if (session.page.isClosed()) throw new PublicError(options.timeoutCode);
    if (watcher.callbackSeen && watcher.settled()) {
      const token = watcher.token ?? (await tokenFromSessionStorage(session));
      session.guard.assertTrusted();
      if (token) return { accessToken: token, accessTokenExp: tokenExpiry(token) };
      throw new PublicError('LOGIN_FAILED');
    }
    if (Date.now() >= deadline) break;
    await session.guard.race(sleep(POLL_MS));
  } while (Date.now() < deadline);
  session.guard.assertTrusted();
  throw new PublicError(options.timeoutCode);
}

async function startFlow(session: BrowserSession): Promise<CallbackWatcher> {
  const watcher = new CallbackWatcher(session);
  try {
    await session.guard.race(session.page.goto(session.policy.schoolOrigin));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    // Navigation was interrupted by the redirect chain; the wait loop decides.
  }
  return watcher;
}

/**
 * Silent refresh through the existing SSO session. Any navigation to a login
 * page is answered locally with an empty document before it loads; then the session counts as expired. In
 * password mode the login form is filled instead.
 */
export async function refreshToken(
  session: BrowserSession,
  deps: ClientDeps
): Promise<AcquiredToken> {
  if (deps.config.authMode === 'password') return passwordLogin(session, deps);

  let loginRequired = false;
  const blockLogin = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && url.pathname !== AUTHORIZE_PATH) {
      loginRequired = true;
      // Answer locally with an empty document: the login page never loads, and
      // unlike abort() this does not commit a chrome-error:// page.
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title></title>',
      });
    }
    return route.fallback();
  };
  const onRequest = (request: Request) => {
    // HTTP redirect hops to the login page are not routed; notice them here.
    if (!request.isNavigationRequest()) return;
    try {
      if (request.frame() !== session.page.mainFrame()) return;
    } catch {
      return;
    }
    const url = new URL(request.url());
    if (url.origin !== session.policy.schoolOrigin && url.pathname !== AUTHORIZE_PATH) {
      loginRequired = true;
    }
  };
  const loginOrigins = [AUTH_ORIGIN, ...deps.config.ssoOrigins];
  for (const origin of loginOrigins) await session.context.route(`${origin}/**`, blockLogin);
  session.page.on('request', onRequest);
  try {
    const watcher = await startFlow(session);
    const token = await waitForToken(session, watcher, {
      timeoutMs: deps.timeouts.refreshMs,
      timeoutCode: 'SESSION_EXPIRED',
      check: () => {
        if (loginRequired) throw new PublicError('SESSION_EXPIRED');
      },
    });
    logEvent('session_refreshed');
    return token;
  } finally {
    session.page.off('request', onRequest);
    for (const origin of loginOrigins) {
      await session.context.unroute(`${origin}/**`, blockLogin).catch(() => undefined);
    }
  }
}

function assertCredentialOrigin(session: BrowserSession, page: Page): void {
  session.guard.assertTrusted();
  if (!session.policy.isCredentialOrigin(page.url())) {
    logEvent('origin_blocked', { kind: 'credentials' }, 'error');
    throw new PublicError('ORIGIN_VIOLATION');
  }
}

async function clickFirstVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if (await element.isVisible().catch(() => false)) {
      await element.click({ timeout: 5_000 });
      return true;
    }
  }
  return false;
}

/**
 * Password mode: fills the Magister login form, but only while the main frame
 * is on https://accounts.magister.net (never on an SSO or other origin).
 */
export async function passwordLogin(
  session: BrowserSession,
  deps: ClientDeps
): Promise<AcquiredToken> {
  const { username, password } = deps.config;
  if (!username || !password) throw new PublicError('CONFIG_INVALID', 'MAGISTER_PASS');
  const page = session.page;
  logEvent('login_started', { mode: 'password' });
  const watcher = await startFlow(session);

  // Either the SSO session completes the flow, or a login form appears.
  const deadline = Date.now() + deps.timeouts.loginMs;
  for (;;) {
    session.guard.assertTrusted();
    if (watcher.callbackSeen && watcher.settled()) {
      return waitForToken(session, watcher, { timeoutMs: 0, timeoutCode: 'LOGIN_FAILED' });
    }
    if (
      await page
        .locator('#username')
        .isVisible()
        .catch(() => false)
    )
      break;
    if (Date.now() >= deadline) throw new PublicError('LOGIN_FAILED');
    await session.guard.race(sleep(POLL_MS));
  }

  assertCredentialOrigin(session, page);
  await page.fill('#username', username, { timeout: deps.timeouts.stepMs });
  assertCredentialOrigin(session, page);
  await page.click(CONTINUE_SELECTOR, { timeout: deps.timeouts.stepMs });
  await session.guard.race(
    page.waitForSelector(PASSWORD_SELECTOR, { timeout: deps.timeouts.stepMs })
  );
  assertCredentialOrigin(session, page);
  await page.fill(PASSWORD_SELECTOR, password, { timeout: deps.timeouts.stepMs });
  await clickFirstVisible(page, CONSENT_SELECTORS).catch(() => false);
  assertCredentialOrigin(session, page);
  if (!(await clickFirstVisible(page, LOGIN_SELECTORS))) await page.keyboard.press('Enter');

  const token = await waitForToken(session, watcher, {
    timeoutMs: deps.timeouts.loginMs,
    timeoutCode: 'LOGIN_FAILED',
  });
  logEvent('login_completed', { mode: 'password' });
  return token;
}

const CHILDREN_ENDPOINTS = (personId: number) => [
  `/api/personen/${personId}/kinderen`,
  '/api/leerlingen',
  `/api/accounts/${personId}/kinderen`,
];

/** The logged-in person id. */
export async function fetchAccountId(session: BrowserSession, token: string): Promise<number> {
  const account = await session.api.get('account', '/api/account', AccountSchema, token);
  return account.Persoon.Id;
}

/**
 * Picks whose schedule to read: MAGISTER_CHILD_ID if linked, otherwise the
 * first linked child, otherwise the account itself.
 */
export async function resolveChild(
  session: BrowserSession,
  config: Config,
  token: string,
  accountPersonId: number
): Promise<number | undefined> {
  let children: number[] = [];
  for (const path of CHILDREN_ENDPOINTS(accountPersonId)) {
    const result = await session.api.getOptional('children', path, ChildrenSchema, token);
    if (result !== null) {
      children = result;
      break;
    }
  }
  if (config.childId !== undefined) {
    if (children.includes(config.childId)) return config.childId;
    if (config.childId === accountPersonId && children.length === 0) return undefined;
    throw new PublicError('CHILD_NOT_FOUND');
  }
  return children[0];
}

export async function resolveIdentity(
  session: BrowserSession,
  config: Config,
  token: string
): Promise<Identity> {
  const accountPersonId = await fetchAccountId(session, token);
  const childId = await resolveChild(session, config, token, accountPersonId);
  return { accountPersonId, childId };
}

export function buildSession(
  deps: ClientDeps,
  identity: Identity,
  token: AcquiredToken,
  storageState: StoredSession['storageState']
): StoredSession {
  if (!deps.store) throw new PublicError('INTERNAL');
  return {
    version: 1,
    schoolOrigin: deps.config.schoolOrigin,
    profileHash: deps.store.profileHash,
    accountPersonId: identity.accountPersonId,
    ...(identity.childId !== undefined ? { childId: identity.childId } : {}),
    sessionId: randomUUID(),
    savedAt: new Date().toISOString(),
    accessToken: token.accessToken,
    accessTokenExp: token.accessTokenExp,
    storageState,
  };
}

export async function captureStorageState(
  session: BrowserSession
): Promise<StoredSession['storageState']> {
  const state = await session.context.storageState();
  return {
    cookies: [...state.cookies],
    origins: [...state.origins],
  } as unknown as StoredSession['storageState'];
}

/**
 * `unofficial-magister-mcp login`: opens a visible Chromium on the school
 * origin. The user types credentials and MFA; we wait for the callback and a
 * working /api/account on the school origin, then store the session.
 */
export async function interactiveLogin(deps: ClientDeps): Promise<void> {
  if (!deps.store || !deps.config.persistSession) {
    throw new PublicError('CONFIG_INVALID', 'MAGISTER_PERSIST_SESSION');
  }
  logEvent('login_started', { mode: 'interactive' });
  const session = await BrowserSession.open(deps, false);
  try {
    const watcher = await startFlow(session);
    const token = await waitForToken(session, watcher, {
      timeoutMs: deps.timeouts.loginMs,
      timeoutCode: 'LOGIN_FAILED',
    });
    const identity = await resolveIdentity(session, deps.config, token.accessToken);
    const stored = buildSession(deps, identity, token, await captureStorageState(session));
    session.guard.assertTrusted();
    await deps.store.writeSession(stored);
    logEvent('login_completed', { mode: 'interactive' });
  } catch (error) {
    logEvent('login_failed', {}, 'warn');
    throw error;
  } finally {
    await session.close();
  }
}
