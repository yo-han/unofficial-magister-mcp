#!/usr/bin/env node
/**
 * Protocol smoke test against the built server (dist/index.js), without
 * credentials and without network access to Magister.
 *
 * It proves that the compiled server speaks MCP over stdio, lists its tools,
 * validates input and refuses to work without a stored session. It does NOT
 * prove that real Magister authentication works.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const SENTINELS = ['smoke-user-sentinel-7f3a', 'smoke-pass-sentinel-9c1e'];
const EXPECTED_TOOLS = [
  'get_dropoff_time',
  'get_homework',
  'get_pickup_time',
  'get_schedule',
  'get_tests',
  'get_week_schedule',
];
const TIMEOUT_MS = 20_000;

function check(condition, label) {
  if (!condition) throw new Error(`smoke check failed: ${label}`);
  console.log(`ok - ${label}`);
}

function textOf(result) {
  return result.content?.[0]?.type === 'text' ? result.content[0].text : '';
}

async function main() {
  if (!existsSync(ENTRY)) throw new Error('dist/index.js is missing; run `npm run build` first');
  const stateDir = await mkdtemp(join(tmpdir(), 'magister-smoke-'));
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    // A neutral cwd, so a developer's .env is never loaded.
    cwd: stateDir,
    env: {
      PATH: process.env.PATH ?? '',
      MAGISTER_SCHOOL: 'smoke-test',
      MAGISTER_STATE_DIR: join(stateDir, 'state'),
      MAGISTER_USER: SENTINELS[0],
      MAGISTER_PASS: SENTINELS[1],
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: 'magister-smoke', version: '0.0.0' });
  const timer = setTimeout(() => {
    console.error('smoke: timed out');
    process.exit(1);
  }, TIMEOUT_MS);
  try {
    await client.connect(transport);
    check(client.getServerVersion()?.name === 'unofficial-magister-mcp', 'initialize');

    const { tools } = await client.listTools();
    check(
      JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(EXPECTED_TOOLS),
      'listTools returns exactly the six tools'
    );

    let unknownRejected = false;
    try {
      await client.callTool({ name: 'no_such_tool', arguments: {} });
    } catch {
      unknownRejected = true;
    }
    check(unknownRejected, 'an unknown tool is a protocol error');

    const invalid = await client.callTool({
      name: 'get_schedule',
      arguments: { date: 'not-a-date' },
    });
    check(
      invalid.isError === true && textOf(invalid).startsWith('[INVALID_ARGUMENT]'),
      'an invalid date is INVALID_ARGUMENT'
    );

    const tooLong = await client.callTool({
      name: 'get_homework',
      arguments: { from: '2026-11-01', to: '2026-12-15' },
    });
    check(
      tooLong.isError === true && textOf(tooLong).startsWith('[INVALID_ARGUMENT]'),
      'a range over 31 days is INVALID_ARGUMENT'
    );

    const today = await client.callTool({ name: 'get_schedule', arguments: { date: 'today' } });
    check(
      today.isError === true && textOf(today).startsWith('[NOT_LOGGED_IN]'),
      'without a session get_schedule is NOT_LOGGED_IN'
    );
    for (const name of ['get_homework', 'get_tests']) {
      const result = await client.callTool({ name, arguments: {} });
      check(
        result.isError === true && textOf(result).startsWith('[NOT_LOGGED_IN]'),
        `without a session ${name} is NOT_LOGGED_IN`
      );
    }
    check(!stderr.includes('"event":"browser_launched"'), 'no browser was started');
  } finally {
    clearTimeout(timer);
    await client.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  check(
    SENTINELS.every((sentinel) => !stderr.includes(sentinel)),
    'stderr contains no credential sentinel'
  );
  console.log('smoke passed. This does not prove real Magister authentication.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'smoke failed');
  process.exit(1);
});
