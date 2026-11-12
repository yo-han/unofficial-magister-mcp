import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('./fixtures/fixture-server.ts', import.meta.url));

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  return content[0].text;
}

describe('MCP over stdio with the synthetic Magister fixture', { timeout: 60_000 }, () => {
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';

  before(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', SERVER],
      env: { PATH: process.env.PATH ?? '', FIXTURE_NOW: '2026-11-16T07:00:00Z' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    client = new Client({ name: 'fixture-test', version: '0.0.0' });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
  });

  it('lists exactly the four tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_dropoff_time',
      'get_pickup_time',
      'get_schedule',
      'get_week_schedule',
    ]);
  });

  it('get_schedule returns the lessons of a day', async () => {
    const result = await client.callTool({ name: 'get_schedule', arguments: { date: 'today' } });
    assert.equal(result.isError, undefined);
    assert.equal(
      textOf(result),
      [
        'Schedule for Mon Nov 16 2026:',
        '',
        '08:30 - 09:20: wis - 1a (T. Synthetic) @ B1.01',
        '09:20 - 10:10: eng - 1a (T. Synthetic) @ B1.01',
        '14:00 - 14:50: bio - 1a (T. Synthetic) @ B1.01',
      ].join('\n')
    );
  });

  it('get_week_schedule returns seven Amsterdam days', async () => {
    const text = textOf(await client.callTool({ name: 'get_week_schedule', arguments: {} }));
    const headers = [...text.matchAll(/^=== (.+) ===$/gm)].map((match) => match[1]);
    assert.deepEqual(headers, [
      'Mon Nov 16 2026',
      'Tue Nov 17 2026',
      'Wed Nov 18 2026',
      'Thu Nov 19 2026',
      'Fri Nov 20 2026',
      'Sat Nov 21 2026',
      'Sun Nov 22 2026',
    ]);
    assert.match(text, /=== Wed Nov 18 2026 ===\nNo classes scheduled/);
  });

  it('get_dropoff_time and get_pickup_time pick the first and last class', async () => {
    const dropoff = await client.callTool({
      name: 'get_dropoff_time',
      arguments: { date: '2026-11-16' },
    });
    assert.equal(textOf(dropoff), 'First class on Mon Nov 16 2026: wis - 1a at 08:30 @ B1.01');
    const pickup = await client.callTool({
      name: 'get_pickup_time',
      arguments: { date: '2026-11-16' },
    });
    assert.equal(textOf(pickup), 'Last class on Mon Nov 16 2026: bio - 1a ends at 14:50 @ B1.01');
  });

  it('distinguishes an empty day from a school-wide cancellation', async () => {
    const empty = await client.callTool({
      name: 'get_schedule',
      arguments: { date: '2026-11-18' },
    });
    assert.equal(textOf(empty), 'Schedule for Wed Nov 18 2026:\n\nNo classes scheduled');
    const cancelled = await client.callTool({
      name: 'get_pickup_time',
      arguments: { date: 'tomorrow' },
    });
    assert.equal(
      textOf(cancelled),
      'No classes on Tue Nov 17 2026 - cancelled (Alle lessen vervallen i.v.m. studiedag)'
    );
  });

  it('never wrote the synthetic password to stderr', () => {
    assert.equal(stderr.includes('synthetic-password-not-real'), false);
    assert.match(stderr, /"event":"login_completed"/);
  });
});
