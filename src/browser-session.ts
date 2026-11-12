import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { applyContextPolicy, PolicyGuard } from './browser-policy.js';
import type { Config } from './config.js';
import { logEvent } from './logger.js';
import { MagisterApi } from './magister-api.js';
import { createOriginPolicy, OriginPolicy } from './security.js';
import type { AccountStore, StoredSession } from './storage.js';

export interface ClientTimeouts {
  /** How long a login (interactive or password) may take. */
  loginMs: number;
  /** How long a silent token refresh may take. */
  refreshMs: number;
  /** Per API request. */
  apiMs: number;
  /** Per login-form step in password mode. */
  stepMs: number;
}

export interface ClientDeps {
  config: Config;
  /** Null when persistence is disabled. */
  store: AccountStore | null;
  launchBrowser: (headless: boolean) => Promise<Browser>;
  /** Hook to install routes before the origin policy (tests use it for the fixture). */
  prepareContext?: (context: BrowserContext) => Promise<void>;
  timeouts: ClientTimeouts;
  /** Produces a fresh MFA code; tests inject synthetic values. */
  getOtp?: () => Promise<string>;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  loginMs: 10 * 60 * 1000,
  refreshMs: 30_000,
  apiMs: 20_000,
  stepMs: 15_000,
};

const CLOSE_TIMEOUT_MS = 5_000;
const BLANK_PATH = '/__unofficial-magister-mcp/blank';

/**
 * One browser, one context, one page, with the origin policy applied.
 *
 * API calls run as fetch() in the page so they share the context's routing
 * (Playwright's APIRequestContext bypasses context.route). Before any login
 * page has been visited, the page shows a synthetic blank document on the
 * school origin that is answered locally and never reaches the network.
 */
export class BrowserSession {
  readonly policy: OriginPolicy;
  readonly api: MagisterApi;
  private closing: Promise<void> | null = null;

  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly guard: PolicyGuard,
    config: Config,
    timeouts: ClientTimeouts
  ) {
    this.policy = createOriginPolicy(config);
    this.api = new MagisterApi(this, config.schoolOrigin, timeouts.apiMs);
  }

  static async open(
    deps: ClientDeps,
    headless: boolean,
    storageState?: StoredSession['storageState']
  ): Promise<BrowserSession> {
    const browser = await deps.launchBrowser(headless);
    logEvent('browser_launched', { headless });
    try {
      const context = await browser.newContext({
        storageState: storageState as BrowserContextOptions['storageState'],
        serviceWorkers: 'block',
      });
      if (deps.prepareContext) await deps.prepareContext(context);
      const guard = await applyContextPolicy(context, createOriginPolicy(deps.config));
      // Registered after the policy, so it answers before the policy's route
      // handler: a fixed local document on the (allowed) school origin.
      await context.route(`${deps.config.schoolOrigin}${BLANK_PATH}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title></title>',
        })
      );
      const page = await context.newPage();
      return new BrowserSession(browser, context, page, guard, deps.config, deps.timeouts);
    } catch (error) {
      await closeWithTimeout(browser);
      throw error;
    }
  }

  /** Makes sure the page is a document on the exact school origin. */
  async ensureSchoolDocument(): Promise<void> {
    this.guard.assertTrusted();
    if (this.policy.isSchoolOrigin(this.page.url())) return;
    await this.guard.race(this.page.goto(`${this.policy.schoolOrigin}${BLANK_PATH}`));
    this.guard.assertTrusted();
  }

  close(): Promise<void> {
    this.closing ??= closeWithTimeout(this.browser);
    return this.closing;
  }
}

async function closeWithTimeout(browser: Browser): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([browser.close().then(() => 'closed' as const), timeout]);
    logEvent(result === 'closed' ? 'browser_closed' : 'browser_close_failed', {}, 'info');
  } catch {
    logEvent('browser_close_failed', {}, 'warn');
  } finally {
    clearTimeout(timer);
  }
}
