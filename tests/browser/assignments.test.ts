import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interactiveLogin } from '../../src/auth.js';
import { CalendarDate, weekRange } from '../../src/dates.js';
import { PublicError, PublicErrorCode } from '../../src/errors.js';
import { MagisterClient } from '../../src/magister.js';
import { createHarness, Harness } from '../fixtures/harness.js';
import {
  assignment,
  CHILD_A,
  CHILD_B,
  FIXTURE_SCHOOL,
  AUTH,
  lesson,
  setAppointments,
} from '../fixtures/magister-routes.js';

/** All people, subjects and texts below are synthetic. */
const MONDAY = '2026-11-16';
const TUESDAY = '2026-11-17';
const WEDNESDAY = '2026-11-18';
const WEEK = weekRange(new Date(`${MONDAY}T07:00:00Z`));

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

function seedMixedWeek(h: Harness) {
  setAppointments(h.state, CHILD_A, MONDAY, [
    lesson(MONDAY, '08:30', '09:20', 'Wiskunde'),
    assignment(MONDAY, '09:20', '10:10', 'Engels', 1, {
      Afgerond: true,
      Inhoud: '<p>Lees <b>hoofdstuk&nbsp;3</b></p><script>bad()</script>',
    }),
    assignment(MONDAY, '14:00', '14:50', 'Biologie', 2, { Inhoud: 'Toets H1 &amp; H2' }),
  ]);
  setAppointments(h.state, CHILD_A, TUESDAY, [
    assignment(TUESDAY, '08:30', '09:20', 'Wiskunde', 1, { Inhoud: null }),
    assignment(TUESDAY, '10:00', '10:50', 'Frans', 6, { Inhoud: 'Informatie' }),
    assignment(TUESDAY, '11:00', '11:50', 'Duits', 7, { Inhoud: 'Aantekening' }),
  ]);
  setAppointments(h.state, CHILD_A, WEDNESDAY, [
    assignment(WEDNESDAY, '09:00', '09:50', 'Scheikunde', 3),
    assignment(WEDNESDAY, '10:00', '10:50', 'Natuurkunde', 4, { Afgerond: false }),
    assignment(WEDNESDAY, '11:00', '11:50', 'Nederlands', 5, { Status: 5 }),
    assignment(WEDNESDAY, '12:00', '12:50', 'Economie', 0),
  ]);
  setAppointments(h.state, CHILD_B, MONDAY, [
    assignment(MONDAY, '08:30', '09:20', 'Geschiedenis', 1, { Inhoud: 'Kind B huiswerk' }),
    assignment(MONDAY, '10:00', '10:50', 'Aardrijkskunde', 2, { Inhoud: 'Kind B toets' }),
  ]);
}

async function loggedIn(env: Record<string, string> = {}, fixture = {}): Promise<Harness> {
  const h = await harness(env, fixture);
  seedMixedWeek(h);
  await interactiveLogin(h.deps);
  return h;
}

const EXPECTED_HOMEWORK = [
  {
    date: MONDAY,
    startTime: '09:20',
    endTime: '10:10',
    subject: 'Engels',
    kind: 'Huiswerk',
    content: 'Lees hoofdstuk 3',
    completed: true,
    cancelled: false,
  },
  {
    date: TUESDAY,
    startTime: '08:30',
    endTime: '09:20',
    subject: 'Wiskunde',
    kind: 'Huiswerk',
    content: '',
    completed: null,
    cancelled: false,
  },
];

const EXPECTED_TESTS = [
  [MONDAY, '14:00', 'Biologie', 'Proefwerk', 'Toets H1 & H2', null, false],
  [WEDNESDAY, '09:00', 'Scheikunde', 'Tentamen', '', null, false],
  [WEDNESDAY, '10:00', 'Natuurkunde', 'Schriftelijke overhoring', '', false, false],
  [WEDNESDAY, '11:00', 'Nederlands', 'Mondelinge overhoring', '', null, true],
];

function withoutStart<T extends { start: string }>(items: T[]): Omit<T, 'start'>[] {
  return items.map(({ start: _start, ...rest }) => rest);
}

function testSummary(items: Awaited<ReturnType<MagisterClient['getTests']>>) {
  return items.map((item) => [
    item.date,
    item.startTime,
    item.subject,
    item.kind,
    item.content,
    item.completed,
    item.cancelled,
  ]);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

describe('browser: homework and tests from the shared agenda cache', () => {
  it('projects homework, tests and the schedule from one API call', async () => {
    const h = await loggedIn();
    const c = client(h);
    const homework = await c.getHomework(WEEK);
    assert.deepEqual(withoutStart(homework), EXPECTED_HOMEWORK);
    assert.deepEqual(testSummary(await c.getTests(WEEK)), EXPECTED_TESTS);

    // Agenda items stay in the schedule exactly as before.
    const week = await c.getWeekSchedule(WEEK);
    assert.deepEqual(
      [MONDAY, TUESDAY, WEDNESDAY].map((date) => week[date].map((item) => item.startTime)),
      [
        ['08:30', '09:20', '14:00'],
        ['08:30', '10:00', '11:00'],
        ['09:00', '10:00', '11:00', '12:00'],
      ]
    );
    assert.equal(week[WEDNESDAY][2].cancelled, true);
    assert.deepEqual(h.state.scheduleCalls, [`${CHILD_A} ${MONDAY} 2026-11-22`]);
    assert.deepEqual(h.state.external, []);
    assert.ok(
      h.state.requests.every((url) => [FIXTURE_SCHOOL, AUTH].includes(new URL(url).origin))
    );
  });

  it('gives the same projections when the schedule is read first', async () => {
    const first = await loggedIn();
    const forward = client(first);
    const forwardHomework = await forward.getHomework(WEEK);
    const forwardTests = await forward.getTests(WEEK);
    const forwardWeek = await forward.getWeekSchedule(WEEK);

    const second = await loggedIn();
    const reverse = client(second);
    const reverseWeek = await reverse.getWeekSchedule(WEEK);
    const reverseTests = await reverse.getTests(WEEK);
    const reverseHomework = await reverse.getHomework(WEEK);

    assert.deepEqual(reverseHomework, forwardHomework);
    assert.deepEqual(reverseTests, forwardTests);
    assert.deepEqual(reverseWeek, forwardWeek);
    assert.equal(second.state.scheduleCalls.length, 1);
  });

  it('only returns items within the requested dates', async () => {
    const h = await loggedIn();
    const c = client(h);
    assert.deepEqual(
      (await c.getTests([WEDNESDAY])).map((item) => item.subject),
      ['Scheikunde', 'Natuurkunde', 'Nederlands']
    );
    assert.deepEqual(
      (await c.getHomework([MONDAY])).map((item) => item.subject),
      ['Engels']
    );
  });

  it('isolates the configured child', async () => {
    const h = await loggedIn({ MAGISTER_CHILD_ID: String(CHILD_B) });
    const c = client(h);
    assert.deepEqual(
      (await c.getHomework(WEEK)).map((item) => item.content),
      ['Kind B huiswerk']
    );
    assert.deepEqual(
      (await c.getTests(WEEK)).map((item) => item.content),
      ['Kind B toets']
    );
    assert.ok(h.state.scheduleCalls.length > 0);
    assert.ok(h.state.scheduleCalls.every((call) => call.startsWith(`${CHILD_B} `)));
  });

  it('returns an empty list for a range without items', async () => {
    const h = await loggedIn();
    const c = client(h);
    const december: CalendarDate[] = ['2026-12-01', '2026-12-02'];
    assert.deepEqual(await c.getHomework(december), []);
    assert.deepEqual(await c.getTests(december), []);
    assert.deepEqual(await c.getHomework([]), []);
  });

  it('stops serving cached items after a logout from another process', async () => {
    const h = await loggedIn();
    const c = client(h);
    assert.equal((await c.getHomework(WEEK)).length, 2);
    await h.store.deleteAccount();
    await assert.rejects(c.getHomework(WEEK), isCode('NOT_LOGGED_IN'));
    await assert.rejects(c.getTests(WEEK), isCode('NOT_LOGGED_IN'));
  });
});

describe('browser: homework and tests at the API boundary', () => {
  it('treats a schema mismatch as an error, not as no homework', async () => {
    const h = await loggedIn({}, { scheduleInvalid: true });
    const c = client(h);
    await assert.rejects(c.getHomework(WEEK), isCode('UPSTREAM_INVALID_RESPONSE'));
    await assert.rejects(c.getTests(WEEK), isCode('UPSTREAM_INVALID_RESPONSE'));
  });

  it('does not follow an API redirect', async () => {
    const h = await loggedIn({}, { scheduleRedirect: 'https://evil.invalid/api' });
    await assert.rejects(client(h).getTests(WEEK), isCode('UPSTREAM_UNAVAILABLE'));
    assert.equal(
      h.state.requests.some((url) => url.includes('evil.invalid')),
      false
    );
  });

  it('rejects a response that advertises more items than it returns', async () => {
    const h = await loggedIn({}, { totalCountOverride: 999 });
    const c = client(h);
    await assert.rejects(c.getHomework(WEEK), isCode('UPSTREAM_INVALID_RESPONSE'));
    // The same check protects the schedule tools from an incomplete day.
    await assert.rejects(c.getSchedule(MONDAY), isCode('UPSTREAM_INVALID_RESPONSE'));
  });

  it('rejects more appointments than the bound', async () => {
    const h = await harness();
    const many = Array.from({ length: 2001 }, (_, index) =>
      assignment(MONDAY, '08:30', '09:20', `Vak ${index}`, 1)
    );
    setAppointments(h.state, CHILD_A, MONDAY, many);
    await interactiveLogin(h.deps);
    await assert.rejects(client(h).getHomework([MONDAY]), isCode('UPSTREAM_INVALID_RESPONSE'));
  });
});
