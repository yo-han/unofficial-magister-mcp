import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  amsterdamDateOf,
  formatDisplayDate,
  resolveDate,
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
