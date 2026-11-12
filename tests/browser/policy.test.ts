import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, chromium } from 'playwright';
import { applyContextPolicy } from '../../src/browser-policy.js';
import { PublicError } from '../../src/errors.js';
import { createOriginPolicy } from '../../src/security.js';
import { createFixtureState, FIXTURE_SCHOOL, installFixture } from '../fixtures/magister-routes.js';

const policy = createOriginPolicy({ schoolOrigin: FIXTURE_SCHOOL, ssoOrigins: [] });
let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

async function setup(overrides: Parameters<typeof createFixtureState>[0] = {}) {
  browser = await chromium.launch({ headless: true });
  const launched = browser;
  const context = await browser.newContext();
  const state = createFixtureState(overrides);
  await installFixture(context, state);
  const guard = await applyContextPolicy(context, policy);
  const page = await context.newPage();
  return { browser: launched, context, guard, page, state };
}

function isViolation(error: unknown) {
  return error instanceof PublicError && error.code === 'ORIGIN_VIOLATION';
}

describe('browser: context origin policy', { timeout: 15000 }, () => {
  it('allows navigation on the school origin', async () => {
    const { guard, page } = await setup();
    await page.goto(`${FIXTURE_SCHOOL}/robots.txt`);
    assert.equal(guard.broken, false);
    assert.doesNotThrow(() => guard.assertTrusted());
  });

  it('breaks trust and closes the context on a scripted navigation away', async () => {
    const { browser: launched, context, guard, page, state } = await setup();
    await page.goto(`${FIXTURE_SCHOOL}/robots.txt`);
    await guard
      .race(
        page.evaluate(() => {
          location.href = 'https://evil.example/';
        })
      )
      .catch(() => undefined);
    await assert.rejects(guard.violation, isViolation);
    assert.equal(guard.broken, true);
    assert.throws(() => guard.assertTrusted(), isViolation);
    assert.equal(
      state.requests.some((url) => url.startsWith('https://evil.example')),
      false
    );
    await guard.closed;
    // Playwright 1.65 lets newPage() on a closed context hang, so check the browser instead.
    assert.equal(launched.contexts().includes(context), false);
  });

  it('detects an HTTP redirect hop that the router never sees', async () => {
    const { guard, page } = await setup({ appRedirect: 'https://evil.invalid/hop' });
    await page.goto(`${FIXTURE_SCHOOL}/magister/`).catch(() => undefined);
    await assert.rejects(guard.violation, isViolation);
    assert.equal(guard.broken, true);
  });

  it('closes a popup that opens a foreign origin', async () => {
    const { context, guard, page, state } = await setup();
    await page.goto(`${FIXTURE_SCHOOL}/robots.txt`);
    const popupPromise = context.waitForEvent('page').catch(() => null);
    // Not awaited: the context closes while this call may still be pending.
    page
      .evaluate(() => {
        window.open('https://evil.example/popup');
      })
      .catch(() => undefined);
    const popup = await popupPromise;
    await assert.rejects(guard.violation, isViolation);
    await guard.closed;
    // The popup request is refused before Playwright may even emit the page.
    assert.equal(popup === null || popup.isClosed(), true);
    assert.equal(
      state.requests.some((url) => url.startsWith('https://evil.example')),
      false
    );
    assert.equal(guard.broken, true);
  });

  it('does not treat a same-origin fetch as a navigation', async () => {
    const { guard, page } = await setup();
    await page.goto(`${FIXTURE_SCHOOL}/robots.txt`);
    const status = await page.evaluate(async () => (await fetch('/api/account')).status);
    assert.equal(status, 401);
    assert.equal(guard.broken, false);
  });
});
