import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublicError } from '../src/errors.js';
import { TOOL_DEFINITIONS, parseToolCall } from '../src/tools.js';

const now = new Date('2026-11-12T10:00:00Z');

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof PublicError && error.code === code);
}

describe('tool definitions', () => {
  it('keeps the four existing tools', () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
      ['get_schedule', 'get_week_schedule', 'get_dropoff_time', 'get_pickup_time']
    );
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

describe('parseToolCall', () => {
  it('resolves dates for date tools', () => {
    assert.deepEqual(parseToolCall('get_schedule', { date: 'today' }, now), {
      name: 'get_schedule',
      date: '2026-11-12',
    });
    assert.deepEqual(parseToolCall('get_dropoff_time', { date: '2026-11-13' }, now), {
      name: 'get_dropoff_time',
      date: '2026-11-13',
    });
    assert.deepEqual(parseToolCall('get_pickup_time', { date: 'tomorrow' }, now), {
      name: 'get_pickup_time',
      date: '2026-11-13',
    });
  });

  it('accepts the week tool with no or empty arguments', () => {
    assert.deepEqual(parseToolCall('get_week_schedule', undefined, now), {
      name: 'get_week_schedule',
    });
    assert.deepEqual(parseToolCall('get_week_schedule', {}, now), { name: 'get_week_schedule' });
  });

  it('rejects unknown tools', () => {
    expectCode(() => parseToolCall('delete_everything', {}, now), 'UNKNOWN_TOOL');
    expectCode(() => parseToolCall('__proto__', {}, now), 'UNKNOWN_TOOL');
  });

  for (const [name, args] of [
    ['get_schedule', undefined],
    ['get_schedule', {}],
    ['get_schedule', { date: 42 }],
    ['get_schedule', { date: 'today', extra: true }],
    ['get_schedule', { date: '2026-02-30' }],
    ['get_schedule', { date: 'x'.repeat(1000) }],
    ['get_pickup_time', { date: null }],
    ['get_week_schedule', { date: 'today' }],
  ] as const) {
    it(`rejects ${name} with ${JSON.stringify(args)?.slice(0, 40)}`, () => {
      expectCode(() => parseToolCall(name, args, now), 'INVALID_ARGUMENT');
    });
  }
});
