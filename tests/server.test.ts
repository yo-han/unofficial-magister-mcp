import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AssignmentItem } from '../src/assignments.js';
import type { CalendarDate } from '../src/dates.js';
import { PublicError } from '../src/errors.js';
import { setLogSink } from '../src/logger.js';
import { createServer, ScheduleClient } from '../src/server.js';

/** All texts below are synthetic. */
const NOW = new Date('2026-11-16T07:00:00Z'); // Monday in Amsterdam

function item(overrides: Partial<AssignmentItem> = {}): AssignmentItem {
  return {
    start: '2026-11-16T09:20:00+01:00',
    date: '2026-11-16',
    startTime: '09:20',
    endTime: '10:10',
    subject: 'Engels',
    kind: 'Huiswerk',
    content: 'Lees hoofdstuk 3\n- opdracht 1',
    completed: true,
    cancelled: false,
    ...overrides,
  };
}

interface Recorder {
  calls: { method: string; dates: CalendarDate[] }[];
  factoryCalls: number;
}

function fakeClient(
  recorder: Recorder,
  result: {
    homework?: AssignmentItem[];
    tests?: AssignmentItem[];
    error?: unknown;
  }
): ScheduleClient {
  const unexpected = async () => {
    throw new Error('schedule methods are not used here');
  };
  return {
    getSchedule: unexpected,
    getWeekSchedule: unexpected,
    getFirstClass: unexpected,
    getLastClass: unexpected,
    getHomework: async (dates) => {
      recorder.calls.push({ method: 'getHomework', dates });
      if (result.error) throw result.error;
      return result.homework ?? [];
    },
    getTests: async (dates) => {
      recorder.calls.push({ method: 'getTests', dates });
      if (result.error) throw result.error;
      return result.tests ?? [];
    },
  };
}

const openClients: Client[] = [];

async function connect(result: Parameters<typeof fakeClient>[1] = {}) {
  const recorder: Recorder = { calls: [], factoryCalls: 0 };
  const server = createServer({
    version: '0.0.0-test',
    now: () => NOW,
    clientFactory: () => {
      recorder.factoryCalls += 1;
      return fakeClient(recorder, result);
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openClients.push(client);
  return { client, recorder };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  return content[0].text;
}

setLogSink(() => undefined);
afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe('MCP server: homework and tests tools', () => {
  it('lists six tools with read-only range schemas for the new two', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'get_schedule',
        'get_week_schedule',
        'get_dropoff_time',
        'get_pickup_time',
        'get_homework',
        'get_tests',
      ]
    );
    for (const tool of tools.slice(4)) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['from', 'to']);
      assert.equal(tool.inputSchema.required, undefined);
    }
    for (const tool of tools.slice(0, 4)) assert.equal(tool.annotations, undefined);
  });

  it('passes the default 14-day range and explicit ranges to the client', async () => {
    const { client, recorder } = await connect();
    await client.callTool({ name: 'get_homework', arguments: {} });
    await client.callTool({ name: 'get_tests' });
    await client.callTool({
      name: 'get_tests',
      arguments: { from: '2026-11-16', to: '2026-11-18' },
    });
    assert.equal(recorder.calls[0].method, 'getHomework');
    assert.equal(recorder.calls[0].dates.length, 14);
    assert.deepEqual(
      [recorder.calls[0].dates[0], recorder.calls[0].dates[13]],
      ['2026-11-16', '2026-11-29']
    );
    assert.deepEqual(recorder.calls[1], { method: 'getTests', dates: recorder.calls[0].dates });
    assert.deepEqual(recorder.calls[2], {
      method: 'getTests',
      dates: ['2026-11-16', '2026-11-17', '2026-11-18'],
    });
    assert.equal(recorder.factoryCalls, 1);
  });

  it('formats homework with a period header, state and indented content', async () => {
    const { client } = await connect({
      homework: [
        item(),
        item({
          date: '2026-11-17',
          startTime: '08:30',
          endTime: '09:20',
          subject: 'Wiskunde',
          content: '',
          completed: null,
          cancelled: true,
        }),
        item({ date: '2026-11-18', subject: 'Frans', content: 'Woordjes', completed: false }),
      ],
    });
    const result = await client.callTool({
      name: 'get_homework',
      arguments: { from: '2026-11-16', to: '2026-11-22' },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      textOf(result),
      [
        'Homework from Mon Nov 16 2026 to Sun Nov 22 2026:',
        '',
        'Mon Nov 16 2026 09:20 - 10:10: Engels (Huiswerk)',
        '  Completed: yes',
        '  Content:',
        '    Lees hoofdstuk 3',
        '    - opdracht 1',
        '',
        'Tue Nov 17 2026 08:30 - 09:20: Wiskunde (Huiswerk) [CANCELLED]',
        '  Completed: unknown',
        '  Content: (no content)',
        '',
        'Wed Nov 18 2026 09:20 - 10:10: Frans (Huiswerk)',
        '  Completed: no',
        '  Content:',
        '    Woordjes',
      ].join('\n')
    );
  });

  it('formats tests with their kind', async () => {
    const { client } = await connect({
      tests: [item({ subject: 'Biologie', kind: 'Proefwerk', content: 'H1', completed: null })],
    });
    const text = textOf(
      await client.callTool({ name: 'get_tests', arguments: { from: 'today', to: 'today' } })
    );
    assert.equal(
      text,
      [
        'Tests from Mon Nov 16 2026 to Mon Nov 16 2026:',
        '',
        'Mon Nov 16 2026 09:20 - 10:10: Biologie (Proefwerk)',
        '  Completed: unknown',
        '  Content:',
        '    H1',
      ].join('\n')
    );
  });

  it('names the period when nothing is found', async () => {
    const { client } = await connect();
    const args = { from: '2026-11-16', to: '2026-11-22' };
    assert.equal(
      textOf(await client.callTool({ name: 'get_homework', arguments: args })),
      'No homework found from Mon Nov 16 2026 to Sun Nov 22 2026.'
    );
    assert.equal(
      textOf(await client.callTool({ name: 'get_tests', arguments: args })),
      'No tests found from Mon Nov 16 2026 to Sun Nov 22 2026.'
    );
  });

  for (const [name, args] of [
    ['get_homework', { from: '2026-11-01', to: '2026-12-15' }],
    ['get_homework', { from: '2026-11-20', to: '2026-11-19' }],
    ['get_tests', { extra: 1 }],
    ['get_tests', { from: 42 }],
  ] as const) {
    it(`rejects ${name} ${JSON.stringify(args)} before creating a client`, async () => {
      const { client, recorder } = await connect();
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /^\[INVALID_ARGUMENT\] /);
      assert.equal(recorder.factoryCalls, 0);
    });
  }

  it('returns fixed public errors from the client', async () => {
    const expired = await connect({ error: new PublicError('SESSION_EXPIRED') });
    const result = await expired.client.callTool({ name: 'get_homework', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), new PublicError('SESSION_EXPIRED').toPublicText());

    const foreign = await connect({ error: new Error('upstream said: secret-sentinel-55') });
    const internal = await foreign.client.callTool({ name: 'get_tests', arguments: {} });
    assert.equal(textOf(internal), '[INTERNAL] An internal error occurred.');
  });
});
