import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleCache, cacheKey } from '../src/cache.js';

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const MINUTE = 60_000;

describe('ScheduleCache', () => {
  it('isolates accounts and children on the same date', () => {
    const cache = new ScheduleCache<string>({ now: clock().now });
    cache.set(cacheKey(1, 10, '2026-11-12'), 'parent-1 child-10', cache.generation);
    cache.set(cacheKey(2, 10, '2026-11-12'), 'parent-2 child-10', cache.generation);
    cache.set(cacheKey(1, 11, '2026-11-12'), 'parent-1 child-11', cache.generation);
    assert.equal(cache.get(cacheKey(1, 10, '2026-11-12'))?.value, 'parent-1 child-10');
    assert.equal(cache.get(cacheKey(2, 10, '2026-11-12'))?.value, 'parent-2 child-10');
    assert.equal(cache.get(cacheKey(1, 11, '2026-11-12'))?.value, 'parent-1 child-11');
    assert.equal(cache.get(cacheKey(2, 11, '2026-11-12')), null);
  });

  it('does not let key parts run into each other', () => {
    assert.notEqual(cacheKey(1, 12, '2026-11-12'), cacheKey(11, 2, '2026-11-12'));
  });

  it('reports fresh, stale-but-usable and expired entries', () => {
    const time = clock();
    const cache = new ScheduleCache<string>({
      now: time.now,
      freshMs: 5 * MINUTE,
      maxStaleMs: 30 * MINUTE,
    });
    const key = cacheKey(1, 1, '2026-11-12');
    cache.set(key, 'v', cache.generation);
    assert.deepEqual(cache.get(key), { value: 'v', fresh: true });
    time.advance(5 * MINUTE + 1);
    assert.deepEqual(cache.get(key), { value: 'v', fresh: false });
    time.advance(25 * MINUTE);
    assert.equal(cache.get(key), null);
  });

  it('evicts the least recently used entry beyond the limit', () => {
    const cache = new ScheduleCache<number>({ now: clock().now, maxEntries: 3 });
    for (const day of ['01', '02', '03']) {
      cache.set(cacheKey(1, 1, `2026-11-${day}`), Number(day), cache.generation);
    }
    cache.get(cacheKey(1, 1, '2026-11-01'));
    cache.set(cacheKey(1, 1, '2026-11-04'), 4, cache.generation);
    assert.equal(cache.size, 3);
    assert.equal(cache.get(cacheKey(1, 1, '2026-11-02')), null);
    assert.equal(cache.get(cacheKey(1, 1, '2026-11-01'))?.value, 1);
  });

  it('ignores writes from before a clear', () => {
    const cache = new ScheduleCache<string>({ now: clock().now });
    const key = cacheKey(1, 1, '2026-11-12');
    const generationAtStart = cache.generation;
    cache.clear();
    cache.set(key, 'late write', generationAtStart);
    assert.equal(cache.get(key), null);
    assert.equal(cache.size, 0);
    cache.set(key, 'current write', cache.generation);
    assert.equal(cache.get(key)?.value, 'current write');
  });
});
