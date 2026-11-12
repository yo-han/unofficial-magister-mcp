import type { BrowserContext, Frame, Page, Request } from 'playwright';
import { PublicError } from './errors.js';
import { logEvent, SafeTag } from './logger.js';
import type { OriginPolicy } from './security.js';

/**
 * Context-wide navigation policy.
 *
 * Every top-level navigation (in every page, including popups) must stay on
 * the school origin, the Magister auth origin or an explicitly configured SSO
 * origin. A navigation elsewhere is aborted, marks the context untrusted and
 * closes it; everything afterwards fails with ORIGIN_VIOLATION. There is no
 * catch-and-continue.
 *
 * Chromium Fetch interception pauses redirect responses before the browser
 * follows their Location, including for fetch/XHR and later redirect hops. Context-close events alone are too late
 * to prevent a 307/308 from forwarding POST credentials. Popups are blocked
 * because their initial navigation can start before a page session exists.
 *
 * Additional layers provide error reporting and initial-navigation checks:
 * - route: sees and can abort the first request of a navigation;
 * - request: also sees HTTP redirect hops, which route never sees;
 * - framenavigated: the committed URL, as the last check.
 *
 * Initial subresource requests remain available to the trusted login pages.
 * Document navigations (including frames), redirect hops and popups are guarded.
 */
export interface PolicyGuard {
  readonly broken: boolean;
  /** Rejects with ORIGIN_VIOLATION once the policy is violated. */
  readonly violation: Promise<never>;
  /** Resolves once the context closed after a violation (never resolves otherwise). */
  readonly closed: Promise<void>;
  /** Throws ORIGIN_VIOLATION if the policy was violated. */
  assertTrusted(): void;
  /** Races a promise against a violation. */
  race<T>(work: Promise<T>): Promise<T>;
}

function mainFrameOf(request: Request): Frame | null {
  try {
    const frame = request.frame();
    return frame.parentFrame() === null ? frame : null;
  } catch {
    // Service worker requests have no frame; they are not navigations.
    return null;
  }
}

function isTopLevelNavigation(request: Request): boolean {
  return request.isNavigationRequest() && mainFrameOf(request) !== null;
}

export async function applyContextPolicy(
  context: BrowserContext,
  policy: OriginPolicy
): Promise<PolicyGuard> {
  let broken = false;
  let rejectViolation: (error: PublicError) => void = () => undefined;
  const violation = new Promise<never>((_, reject) => {
    rejectViolation = reject;
  });
  // A violation nobody is racing against must not become an unhandled rejection.
  violation.catch(() => undefined);

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const violate = (kind: SafeTag) => {
    if (broken) return;
    broken = true;
    logEvent('origin_blocked', { kind }, 'error');
    rejectViolation(new PublicError('ORIGIN_VIOLATION'));
    context
      .close()
      .catch(() => logEvent('browser_close_failed', {}, 'warn'))
      .finally(resolveClosed);
  };

  let mainPage: Page | null = null;
  const watchPage = (page: Page) => {
    if (mainPage !== null && mainPage !== page) {
      violate('popup');
      return;
    }
    mainPage = page;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && !policy.isNavigationAllowed(frame.url())) {
        violate('navigation');
      }
    });
  };

  const sessions = new WeakMap<Page, Promise<void>>();
  const protectRedirectRequests = (page: Page): Promise<void> => {
    const existing = sessions.get(page);
    if (existing) return existing;
    const pending = (async () => {
      const session = await context.newCDPSession(page);
      session.on('Fetch.requestPaused', async (event) => {
        try {
          const status = event.responseStatusCode ?? 0;
          const location = event.responseHeaders?.find(
            (header: { name: string }) => header.name.toLowerCase() === 'location'
          )?.value;
          const target =
            status >= 300 && status < 400 && location
              ? new URL(location, event.request.url).href
              : null;
          if (broken || (target !== null && !policy.isNavigationAllowed(target))) {
            await session.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            });
            violate('redirect');
          } else {
            await session.send('Fetch.continueResponse', { requestId: event.requestId });
          }
        } catch {
          if (!broken) violate('navigation');
        }
      });
      await session.send('Fetch.enable', { patterns: [{ requestStage: 'Response' }] });
    })();
    sessions.set(page, pending);
    return pending;
  };

  context.on('page', watchPage);
  context.pages().forEach(watchPage);

  context.on('request', (request) => {
    if (!isTopLevelNavigation(request)) return;
    if (request.redirectedFrom() !== null && !policy.isNavigationAllowed(request.url())) {
      violate('redirect');
    }
  });

  // Registered last so it runs before any other route handler on the context.
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (broken) return route.abort('blockedbyclient');
    if (request.isNavigationRequest()) {
      let frame: Frame | null = null;
      try {
        frame = request.frame();
      } catch {
        /* Popup request before its page exists. */
      }
      if (!frame) {
        // Reject popup/unknown-frame navigation before it can send a request.
        violate('popup');
        return route.abort('blockedbyclient');
      }
      const page = frame.page();
      if (mainPage !== null && page !== mainPage) {
        violate('popup');
        return route.abort('blockedbyclient');
      }
      try {
        await protectRedirectRequests(page);
      } catch {
        violate('navigation');
        return route.abort('blockedbyclient');
      }
    }
    if (request.isNavigationRequest() && !policy.isNavigationAllowed(request.url())) {
      violate('navigation');
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });

  return {
    get broken() {
      return broken;
    },
    violation,
    closed,
    assertTrusted() {
      if (broken) throw new PublicError('ORIGIN_VIOLATION');
    },
    race<T>(work: Promise<T>) {
      return Promise.race([work, violation]);
    },
  };
}
