import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { interactiveLogin } from '../../src/auth.js';
import { weekRange } from '../../src/dates.js';
import { PublicError, PublicErrorCode } from '../../src/errors.js';
import { MagisterClient } from '../../src/magister.js';
import { createHarness, Harness } from '../fixtures/harness.js';
import {
  allDayNotice,
  AUTH,
  CHILD_A,
  CHILD_B,
  FIXTURE_SCHOOL,
  lesson,
  PARENT_ID,
  setAppointments,
  TEST_PASSWORD,
  TEST_USERNAME,
} from '../fixtures/magister-routes.js';

const MONDAY = '2026-11-16';
const TUESDAY = '2026-11-17';

const harnesses: Harness[] = [];
const clients: MagisterClient[] = [];

async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const created = await createHarness(...args);
  harnesses.push(created);
  return created;
}

function client(h: Harness): MagisterClient {
  const created = new MagisterClient(h.deps);
  clients.push(created);
  return created;
}

function isCode(code: PublicErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof PublicError, `expected PublicError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function seedLessons(h: Harness, personId = CHILD_A) {
  setAppointments(h.state, personId, MONDAY, [
    lesson(MONDAY, '08:30', '09:20', 'Wiskunde'),
    lesson(MONDAY, '09:20', '10:10', 'Engels'),
    lesson(MONDAY, '14:00', '14:50', 'Biologie'),
  ]);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

describe('browser: interactive login and session reuse', () => {
  it('saves a private session and reuses it headless without the login UI', async () => {
    const h = await harness();
    seedLessons(h);
    await interactiveLogin(h.deps);
    assert.deepEqual(h.launches, [{ headless: false }]);
    assert.equal(statSync(h.store.sessionPath).mode & 0o777, 0o600);
    const saved = await h.store.readSession();
    assert.equal(saved?.accountPersonId, PARENT_ID);
    assert.equal(saved?.childId, CHILD_A);
    assert.equal(JSON.stringify(saved).includes(TEST_PASSWORD), false);

    const loginPostsAfterLogin = h.state.loginPosts.length;
    const authorizeAfterLogin = h.state.authorizeCalls;
    const items = await client(h).getSchedule(MONDAY);
    assert.deepEqual(
      items.map((item) => [item.startTime, item.endTime, item.subject]),
      [
        ['08:30', '09:20', 'wis - 1a'],
        ['09:20', '10:10', 'eng - 1a'],
        ['14:00', '14:50', 'bio - 1a'],
      ]
    );
    assert.equal(items[0].teacher, 'T. Synthetic');
    assert.equal(items[0].location, 'B1.01');
    assert.deepEqual(h.launches, [{ headless: false }, { headless: true }]);
    assert.equal(h.state.loginPosts.length, loginPostsAfterLogin);
    assert.equal(h.state.authorizeCalls, authorizeAfterLogin);
    assert.deepEqual(h.state.external, []);
  });

  it('returns NOT_LOGGED_IN without starting a browser when there is no session', async () => {
    const h = await harness();
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('NOT_LOGGED_IN'));
    assert.deepEqual(h.launches, []);
  });

  it('refuses login when persistence is disabled', async () => {
    const h = await harness({ MAGISTER_PERSIST_SESSION: 'false' });
    await assert.rejects(interactiveLogin(h.deps), isCode('CONFIG_INVALID'));
    assert.deepEqual(h.launches, []);
  });

  it('fails the login when nobody completes it before the timeout', async () => {
    const h = await harness({}, { loginBehaviour: 'manual' });
    await assert.rejects(interactiveLogin(h.deps), isCode('LOGIN_FAILED'));
    assert.equal(existsSync(h.store.sessionPath), false);
  });

  it('never accepts an id_token as access token', async () => {
    const h = await harness({}, { idTokenOnly: true });
    await assert.rejects(interactiveLogin(h.deps), isCode('LOGIN_FAILED'));
    assert.equal(existsSync(h.store.sessionPath), false);
  });

  it('expires sessions older than the configured maximum without a browser', async () => {
    const h = await harness();
    await interactiveLogin(h.deps);
    const saved = await h.store.readSession();
    assert.ok(saved);
    await h.store.writeSession({ ...saved, savedAt: '2020-01-01T00:00:00.000Z' });
    const launchesBefore = h.launches.length;
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('SESSION_EXPIRED'));
    assert.equal(h.launches.length, launchesBefore);
  });
});

describe('browser: origin policy', () => {
  it('stops on a navigation to a foreign origin and saves nothing', async () => {
    const h = await harness({}, { afterCallback: 'https://evil.example/steal' });
    await assert.rejects(interactiveLogin(h.deps), isCode('ORIGIN_VIOLATION'));
    assert.equal(existsSync(h.store.sessionPath), false);
    // The policy aborted it before the fixture (or the network) saw it.
    assert.equal(
      h.state.requests.some((url) => url.startsWith('https://evil.example')),
      false
    );
  });

  it('closes a popup to a foreign origin and stops', async () => {
    const h = await harness(
      {},
      { loginBehaviour: 'manual', popupFromLogin: 'https://evil.example/popup' }
    );
    await assert.rejects(interactiveLogin(h.deps), isCode('ORIGIN_VIOLATION'));
    assert.equal(
      h.state.requests.some((url) => url.startsWith('https://evil.example')),
      false
    );
    assert.equal(existsSync(h.store.sessionPath), false);
  });

  it('password mode fills credentials only on accounts.magister.net', async () => {
    const env = {
      MAGISTER_AUTH_MODE: 'password',
      MAGISTER_USER: TEST_USERNAME,
      MAGISTER_PASS: TEST_PASSWORD,
    };
    // Positive: the form on the Magister auth origin gets filled and the session works.
    const good = await harness(env, { loginBehaviour: 'manual' });
    seedLessons(good);
    const items = await client(good).getSchedule(MONDAY);
    assert.equal(items.length, 3);
    assert.deepEqual(
      good.state.loginPosts.map((post) => post.origin),
      [AUTH]
    );

    // Negative: the same form on an (allowed) SSO origin is never filled.
    const sso = await harness(
      { ...env, MAGISTER_SSO_ORIGINS: 'https://sso.example.org' },
      { loginBehaviour: 'manual', loginOrigin: 'https://sso.example.org' }
    );
    await assert.rejects(client(sso).getSchedule(MONDAY), isCode('ORIGIN_VIOLATION'));
    assert.deepEqual(sso.state.loginPosts, []);
  });

  it('password mode reports a failed login instead of continuing', async () => {
    const h = await harness(
      { MAGISTER_AUTH_MODE: 'password', MAGISTER_USER: TEST_USERNAME, MAGISTER_PASS: 'wrong' },
      { loginBehaviour: 'manual' }
    );
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('LOGIN_FAILED'));
    assert.equal(h.state.loginPosts.length, 1);
    assert.equal(existsSync(h.store.sessionPath), false);
  });
});

describe('browser: session validation and API boundary', () => {
  it('silently refreshes a rejected token while the SSO session is valid', async () => {
    const h = await harness();
    seedLessons(h);
    await interactiveLogin(h.deps);
    const before = await h.store.readSession();
    h.state.issuedTokens.clear();
    const items = await client(h).getSchedule(MONDAY);
    assert.equal(items.length, 3);
    const after = await h.store.readSession();
    assert.notEqual(after?.accessToken, before?.accessToken);
    assert.equal(after?.sessionId, before?.sessionId);
    assert.equal(after?.savedAt, before?.savedAt);
  });

  it('reports SESSION_EXPIRED when /api/account keeps answering 401', async () => {
    const h = await harness();
    await interactiveLogin(h.deps);
    h.state.issuedTokens.clear();
    h.state.ssoSessions.clear();
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('SESSION_EXPIRED'));
  });

  it('reports SESSION_EXPIRED for a forced 401 even after a refresh', async () => {
    const h = await harness();
    await interactiveLogin(h.deps);
    h.state.options.accountStatus = 401;
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('SESSION_EXPIRED'));
  });

  it('detects a restored session that belongs to another account', async () => {
    const h = await harness();
    await interactiveLogin(h.deps);
    h.state.options.accountPersonId = 9999;
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('SESSION_MISMATCH'));
  });

  it('selects the configured child of a parent account', async () => {
    const h = await harness({ MAGISTER_CHILD_ID: String(CHILD_B) });
    seedLessons(h, CHILD_B);
    await interactiveLogin(h.deps);
    const items = await client(h).getSchedule(MONDAY);
    assert.equal(items.length, 3);
    assert.ok(h.state.scheduleCalls.every((call) => call.startsWith(`${CHILD_B} `)));
  });

  it('rejects a configured child that is not linked to the account', async () => {
    const h = await harness({ MAGISTER_CHILD_ID: '424242' });
    await assert.rejects(interactiveLogin(h.deps), isCode('CHILD_NOT_FOUND'));
  });

  it('uses the account itself when there are no children', async () => {
    const h = await harness({}, { children: [] });
    seedLessons(h, PARENT_ID);
    await interactiveLogin(h.deps);
    assert.equal((await client(h).getSchedule(MONDAY)).length, 3);
    assert.ok(h.state.scheduleCalls.every((call) => call.startsWith(`${PARENT_ID} `)));
  });

  it('does not follow an API redirect', async () => {
    const h = await harness({}, { scheduleRedirect: 'https://evil.invalid/api' });
    await interactiveLogin(h.deps);
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('UPSTREAM_UNAVAILABLE'));
    assert.equal(
      h.state.requests.some((url) => url.includes('evil.invalid')),
      false
    );
  });

  it('treats a schema mismatch as an error, not as an empty day', async () => {
    const h = await harness({}, { scheduleInvalid: true });
    await interactiveLogin(h.deps);
    await assert.rejects(client(h).getSchedule(MONDAY), isCode('UPSTREAM_INVALID_RESPONSE'));
  });
});

describe('browser: schedules, concurrency and logout', () => {
  it('returns a day and a week with Amsterdam dates', async () => {
    const h = await harness();
    seedLessons(h);
    setAppointments(h.state, CHILD_A, TUESDAY, [
      allDayNotice(TUESDAY, '2026-11-18', 'Alle lessen vervallen i.v.m. studiedag'),
    ]);
    await interactiveLogin(h.deps);
    const c = client(h);
    const dates = weekRange(new Date(`${MONDAY}T07:00:00Z`));
    const week = await c.getWeekSchedule(dates);
    assert.deepEqual(Object.keys(week), dates);
    assert.equal(week[MONDAY].length, 3);
    assert.equal(week[TUESDAY].length, 1);
    assert.equal(week[TUESDAY][0].startTime, '00:00');
    assert.equal(week['2026-11-18'].length, 0);
    // One API call for the whole range.
    assert.deepEqual(h.state.scheduleCalls, [`${CHILD_A} ${MONDAY} 2026-11-22`]);

    assert.deepEqual(await c.getLastClass(TUESDAY), {
      class: null,
      cancellationReason: 'Alle lessen vervallen i.v.m. studiedag',
    });
    assert.equal((await c.getFirstClass(MONDAY)).class?.startTime, '08:30');
    // Served from the per-account cache: no extra schedule calls.
    assert.equal(h.state.scheduleCalls.length, 1);
  });

  it('starts one browser for concurrent first calls', async () => {
    const h = await harness();
    seedLessons(h);
    await interactiveLogin(h.deps);
    const c = client(h);
    const results = await Promise.all([
      c.getSchedule(MONDAY),
      c.getSchedule(TUESDAY),
      c.getFirstClass(MONDAY),
    ]);
    assert.equal(results[0].length, 3);
    assert.deepEqual(
      h.launches.filter((launch) => launch.headless),
      [{ headless: true }]
    );
  });

  it('notices a logout from another process and stops using the session', async () => {
    const h = await harness();
    seedLessons(h);
    await interactiveLogin(h.deps);
    const c = client(h);
    assert.equal((await c.getSchedule(MONDAY)).length, 3);
    await h.store.deleteAccount();
    await assert.rejects(c.getSchedule(MONDAY), isCode('NOT_LOGGED_IN'));
  });

  it('does not recreate the session when logout happens during a refresh', async () => {
    const h = await harness({}, { authorizeDelayMs: 1500 });
    seedLessons(h);
    await interactiveLogin(h.deps);
    h.state.issuedTokens.clear();
    const pending = client(h).getSchedule(MONDAY);
    // Wait until the refresh is in flight, then log out like the CLI would.
    while (h.state.authorizeCalls < 2) await new Promise((r) => setTimeout(r, 25));
    assert.equal(await h.store.deleteAccount(), true);
    await assert.rejects(pending, isCode('NOT_LOGGED_IN'));
    assert.equal(existsSync(h.store.sessionPath), false);
    assert.equal(existsSync(h.store.accountDir), false);
  });

  it('never talks to an origin outside the fixture', async () => {
    const h = await harness();
    seedLessons(h);
    await interactiveLogin(h.deps);
    await client(h).getSchedule(MONDAY);
    assert.deepEqual(h.state.external, []);
    assert.ok(
      h.state.requests.every((url) => [FIXTURE_SCHOOL, AUTH].includes(new URL(url).origin))
    );
  });
});
