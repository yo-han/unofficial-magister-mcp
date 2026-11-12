import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublicError } from '../src/errors.js';
import { TOOL_DEFINITIONS, parseToolCall } from '../src/tools.js';

const now = new Date('2026-11-12T10:00:00Z');

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof PublicError && error.code === code);
}

const DATE_HINT =
  'Can be "today", "tomorrow", a weekday name, or YYYY-MM-DD format (Europe/Amsterdam)';

function legacyDateSchema(description: string) {
  return {
    type: 'object',
    properties: {
      date: { type: 'string', maxLength: 32, description: `${description}. ${DATE_HINT}` },
    },
    required: ['date'],
    additionalProperties: false,
  };
}

/** The four original tools exactly as published before homework and tests existed. */
const LEGACY_DEFINITIONS = [
  {
    name: 'get_schedule',
    description: 'Get school schedule for a specific date',
    inputSchema: legacyDateSchema('Date to get schedule for'),
  },
  {
    name: 'get_week_schedule',
    description: 'Get school schedule for the entire week (next 7 days)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_dropoff_time',
    description: 'Get the time of the first class (for drop-off planning)',
    inputSchema: legacyDateSchema('Date to check'),
  },
  {
    name: 'get_pickup_time',
    description: 'Get the time of the last class (for pick-up planning)',
    inputSchema: legacyDateSchema('Date to check'),
  },
];

describe('tool definitions', () => {
  it('lists the four existing tools followed by homework and tests', () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
      [
        'get_schedule',
        'get_week_schedule',
        'get_dropoff_time',
        'get_pickup_time',
        'get_homework',
        'get_tests',
      ]
    );
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it('keeps the four existing definitions unchanged', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(TOOL_DEFINITIONS.slice(0, 4))), LEGACY_DEFINITIONS);
  });

  for (const name of ['get_homework', 'get_tests']) {
    it(`publishes a read-only optional from/to schema for ${name}`, () => {
      const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      assert.ok(tool && 'annotations' in tool);
      assert.equal(tool.annotations.readOnlyHint, true);
      const schema = tool.inputSchema as {
        properties: Record<string, { type: string; maxLength: number; description: string }>;
        required?: unknown;
      };
      assert.equal(schema.required, undefined);
      assert.deepEqual(Object.keys(schema.properties), ['from', 'to']);
      for (const property of Object.values(schema.properties)) {
        assert.equal(property.type, 'string');
        assert.equal(property.maxLength, 32);
        assert.match(property.description, /inclusive/i);
        assert.match(property.description, /Europe\/Amsterdam/);
      }
      assert.match(tool.description, /14 days/);
      assert.match(tool.description, /31 days/);
    });
  }
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

  for (const name of ['get_homework', 'get_tests'] as const) {
    it(`resolves ranges for ${name}`, () => {
      const defaultRange = parseToolCall(name, undefined, now);
      assert.equal(defaultRange.name, name);
      assert.ok('dates' in defaultRange);
      assert.equal(defaultRange.dates.length, 14);
      assert.deepEqual(parseToolCall(name, {}, now), defaultRange);
      assert.deepEqual(parseToolCall(name, { from: '2026-11-16', to: '2026-11-18' }, now), {
        name,
        dates: ['2026-11-16', '2026-11-17', '2026-11-18'],
      });
      const fromOnly = parseToolCall(name, { from: 'tomorrow' }, now);
      assert.ok('dates' in fromOnly);
      assert.deepEqual([fromOnly.dates[0], fromOnly.dates.length], ['2026-11-13', 14]);
      assert.deepEqual(parseToolCall(name, { to: 'saturday' }, now), {
        name,
        dates: ['2026-11-12', '2026-11-13', '2026-11-14'],
      });
    });
  }

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
    ['get_homework', { from: 42 }],
    ['get_homework', { from: null }],
    ['get_homework', { extra: 1 }],
    ['get_homework', { date: 'today' }],
    ['get_homework', { from: 'x'.repeat(33) }],
    ['get_homework', ['2026-11-16']],
    ['get_homework', { from: '2026-12-01', to: '2027-01-01' }],
    ['get_tests', { to: 42 }],
    ['get_tests', { from: '2026-11-20', to: '2026-11-19' }],
    ['get_tests', { from: '2026-02-30' }],
    ['get_tests', 'today'],
  ] as const) {
    it(`rejects ${name} with ${JSON.stringify(args)?.slice(0, 40)}`, () => {
      expectCode(() => parseToolCall(name, args, now), 'INVALID_ARGUMENT');
    });
  }
});
