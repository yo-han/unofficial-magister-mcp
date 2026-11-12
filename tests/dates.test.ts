import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  amsterdamDateOf,
  formatDisplayDate,
  MAX_RANGE_DAYS,
  resolveDate,
  resolveRange,
  weekRange,
} from '../src/dates.js';
import { PublicError } from '../src/errors.js';

function expectInvalid(input: string, now: Date) {
  assert.throws(
    () => resolveDate(input, now),
    (error: unknown) => error instanceof PublicError && error.code === 'INVALID_ARGUMENT'
  );
}

describe('resolveDate', () => {
  // 2026-07-14 22:30Z is 2026-07-15 00:30 in Amsterdam (summer time, UTC+2).
  const summerAfterMidnight = new Date('2026-07-14T22:30:00Z');
  // 2026-01-14 23:30Z is 2026-01-15 00:30 in Amsterdam (winter time, UTC+1).
  const winterAfterMidnight = new Date('2026-01-14T23:30:00Z');
  // 2026-01-14 22:30Z is still 2026-01-14 23:30 in Amsterdam.
  const winterBeforeMidnight = new Date('2026-01-14T22:30:00Z');

  it('resolves today in Amsterdam, not UTC', () => {
    assert.equal(resolveDate('today', summerAfterMidnight), '2026-07-15');
    assert.equal(resolveDate('today', winterAfterMidnight), '2026-01-15');
    assert.equal(resolveDate('today', winterBeforeMidnight), '2026-01-14');
  });

  it('resolves tomorrow across month and year boundaries', () => {
    assert.equal(resolveDate('tomorrow', new Date('2026-12-31T12:00:00Z')), '2027-01-01');
    assert.equal(resolveDate('Tomorrow', new Date('2026-02-28T12:00:00Z')), '2026-03-01');
  });

  it('resolves weekday names to the next occurrence, a week ahead for today', () => {
    // 2026-07-15 is a Wednesday in Amsterdam.
    assert.equal(resolveDate('wednesday', summerAfterMidnight), '2026-07-22');
    assert.equal(resolveDate('thursday', summerAfterMidnight), '2026-07-16');
    assert.equal(resolveDate('Monday', summerAfterMidnight), '2026-07-20');
    assert.equal(resolveDate('sunday', summerAfterMidnight), '2026-07-19');
  });

  it('accepts real ISO calendar dates', () => {
    assert.equal(resolveDate('2026-02-28', summerAfterMidnight), '2026-02-28');
    assert.equal(resolveDate('2028-02-29', summerAfterMidnight), '2028-02-29');
  });

  for (const input of [
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-1-1',
    '2026-01-01T00:00:00Z',
    'garbage',
    '',
    'next week',
    '12/11/2026',
    'Nov 12 2026',
    '1969-12-31',
    '3000-01-01',
    ' today',
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expectInvalid(input, summerAfterMidnight);
    });
  }
});

describe('date helpers', () => {
  it('formats a calendar date without timezone shifts', () => {
    assert.equal(formatDisplayDate('2026-11-12'), 'Thu Nov 12 2026');
    assert.equal(formatDisplayDate('2026-03-01'), 'Sun Mar 01 2026');
  });

  it('adds days across DST changes', () => {
    assert.equal(addDays('2026-03-28', 1), '2026-03-29');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  });

  it('builds a 7-day range starting today in Amsterdam', () => {
    assert.deepEqual(weekRange(new Date('2026-12-28T23:30:00Z')), [
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
      '2027-01-04',
    ]);
  });

  it('maps an instant to its Amsterdam calendar date', () => {
    assert.equal(amsterdamDateOf('2026-11-11T23:00:00Z'), '2026-11-12');
    assert.equal(amsterdamDateOf('2026-11-11T22:59:59Z'), '2026-11-11');
    assert.equal(amsterdamDateOf('2026-07-14T22:00:00+00:00'), '2026-07-15');
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-11-12T10:00:00Z'); // Thursday in Amsterdam

  function expectRangeInvalid(from: string | undefined, to: string | undefined, at = now) {
    assert.throws(
      () => resolveRange(from, to, at),
      (error: unknown) => error instanceof PublicError && error.code === 'INVALID_ARGUMENT'
    );
  }

  function assertConsecutive(dates: string[]) {
    for (let index = 1; index < dates.length; index += 1) {
      assert.equal(dates[index], addDays(dates[index - 1], 1));
    }
    assert.equal(new Set(dates).size, dates.length);
  }

  it('defaults to today through today+13 (14 inclusive days)', () => {
    const dates = resolveRange(undefined, undefined, now);
    assert.equal(dates.length, 14);
    assert.equal(dates[0], '2026-11-12');
    assert.equal(dates[13], '2026-11-25');
    assertConsecutive(dates);
  });

  it('defaults to to from+13 and from to today', () => {
    const fromOnly = resolveRange('2026-12-01', undefined, now);
    assert.equal(fromOnly.length, 14);
    assert.deepEqual([fromOnly[0], fromOnly[13]], ['2026-12-01', '2026-12-14']);
    const toOnly = resolveRange(undefined, '2026-11-15', now);
    assert.deepEqual(toOnly, ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  });

  it('accepts a single day and exactly 31 days', () => {
    assert.deepEqual(resolveRange('2026-11-16', '2026-11-16', now), ['2026-11-16']);
    const month = resolveRange('2026-12-01', '2026-12-31', now);
    assert.equal(MAX_RANGE_DAYS, 31);
    assert.equal(month.length, 31);
    assert.deepEqual([month[0], month[30]], ['2026-12-01', '2026-12-31']);
    assertConsecutive(month);
  });

  it('rejects 32 days and far larger ranges', () => {
    expectRangeInvalid('2026-12-01', '2027-01-01');
    expectRangeInvalid('1970-01-01', '2999-12-31');
  });

  it('rejects a reversed range', () => {
    expectRangeInvalid('2026-11-20', '2026-11-19');
    expectRangeInvalid(undefined, '2026-11-11');
  });

  it('accepts the date aliases in both fields', () => {
    assert.deepEqual(resolveRange('today', 'tomorrow', now), ['2026-11-12', '2026-11-13']);
    assert.deepEqual(resolveRange('tomorrow', 'saturday', now), ['2026-11-13', '2026-11-14']);
    // "monday" is the next Monday (Nov 16), so friday..monday is Nov 13..16.
    assert.equal(resolveRange('friday', 'monday', now).length, 4);
    // A weekday a week ahead resolves later than "today".
    expectRangeInvalid('thursday', 'today');
  });

  it('rejects invalid calendar dates and unknown words', () => {
    expectRangeInvalid('2026-02-30', undefined);
    expectRangeInvalid(undefined, '2026-02-30');
    expectRangeInvalid('next week', undefined);
    expectRangeInvalid('', undefined);
  });

  it('rejects a default end beyond the supported year domain', () => {
    expectRangeInvalid('2999-12-25', undefined);
    assert.equal(resolveRange('2999-12-18', undefined, now).at(-1), '2999-12-31');
  });

  it('starts at the Amsterdam date, not the UTC date', () => {
    const dates = resolveRange(undefined, undefined, new Date('2026-01-14T23:30:00Z'));
    assert.equal(dates[0], '2026-01-15');
    assert.equal(dates[13], '2026-01-28');
  });

  it('enumerates ranges across both DST changes without gaps or duplicates', () => {
    const spring = resolveRange('2026-03-20', '2026-04-05', now);
    assert.equal(spring.length, 17);
    assert.ok(spring.includes('2026-03-29') && spring.includes('2026-03-30'));
    assertConsecutive(spring);
    const autumn = resolveRange('2026-10-20', '2026-11-05', now);
    assert.equal(autumn.length, 17);
    assert.ok(autumn.includes('2026-10-25') && autumn.includes('2026-10-26'));
    assertConsecutive(autumn);
  });
});
