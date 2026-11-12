import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PublicError, toPublicError } from '../src/errors.js';
import { logEvent, setLogSink } from '../src/logger.js';
import { createServer, ScheduleClient } from '../src/server.js';

const secrets = ['password-sentinel-123', 'access-token-sentinel-456'];

function hostileError(): Error {
  const cause = new Error(`cause with ${secrets[0]}`);
  const error = new Error(
    `page.fill: failed at https://mencia.magister.net/oidc/redirect_callback.html#access_token=${secrets[1]} while typing ${secrets[0]}`,
    { cause }
  );
  Object.assign(error, { url: `https://x/?token=${secrets[1]}` });
  return error;
}

const throwingClient: ScheduleClient = {
  getSchedule: async () => {
    throw hostileError();
  },
  getWeekSchedule: async () => {
    throw hostileError();
  },
  getFirstClass: async () => {
    throw hostileError();
  },
  getLastClass: async () => {
    throw hostileError();
  },
};

interface Captured {
  text: () => string;
  restore: () => void;
}

/** Captures everything written to stdout, stderr and the log sink. */
function captureOutput(): Captured {
  const chunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const record = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  };
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
  setLogSink((line) => chunks.push(line));
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      setLogSink(undefined);
    },
  };
}

async function readAllFiles(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const contents = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  );
  return contents.join('\n');
}

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'leak-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callAllTools(client: Client): Promise<string> {
  const results = [];
  for (const [name, args] of [
    ['get_schedule', { date: 'today' }],
    ['get_week_schedule', {}],
    ['get_dropoff_time', { date: 'tomorrow' }],
    ['get_pickup_time', { date: '2026-11-13' }],
  ] as const) {
    results.push(await client.callTool({ name, arguments: args }));
  }
  return JSON.stringify(results);
}

function assertNoSecrets(output: string) {
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false, `output leaked ${secret}`);
  }
}

describe('secret-safe errors and logs', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'magister-leak-'));
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('never surfaces exception text through tool results, stdout, stderr or files', async () => {
    const captured = captureOutput();
    let toolOutput: string;
    try {
      const server = createServer({
        clientFactory: () => throwingClient,
        now: () => new Date('2026-11-12T10:00:00Z'),
        version: '0.0.0-test',
      });
      const client = await connect(server);
      toolOutput = await callAllTools(client);
      await client.close();
    } finally {
      captured.restore();
    }
    const everything = [toolOutput, captured.text(), await readAllFiles(stateDir)].join('\n');
    assertNoSecrets(everything);
    // The client still learns that it failed, with a stable code.
    assert.match(toolOutput, /\[INTERNAL\]/);
    assert.match(toolOutput, /"isError":true/);
    // And the failure was logged as an event with that code.
    assert.match(captured.text(), /"event":"tool_failed"/);
  });

  it('detects a leak when a handler forwards error.message (counter-proof)', async () => {
    const captured = captureOutput();
    let toolOutput = '';
    try {
      const leaky = new Server({ name: 'leaky', version: '0' }, { capabilities: { tools: {} } });
      leaky.setRequestHandler(CallToolRequestSchema, async () => {
        try {
          await throwingClient.getSchedule('2026-11-12');
          return { content: [] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
          };
        }
      });
      const client = await connect(leaky);
      toolOutput = await callAllTools(client);
      await client.close();
    } finally {
      captured.restore();
    }
    assert.throws(() => assertNoSecrets(toolOutput + captured.text()), /leaked/);
  });

  it('does not let a non-public error become public', () => {
    const publicError = toPublicError(hostileError());
    assert.equal(publicError.code, 'INTERNAL');
    assertNoSecrets(publicError.toPublicText());
    assertNoSecrets(JSON.stringify(publicError));
    assert.equal(publicError.cause, undefined);
    const known = new PublicError('SESSION_EXPIRED');
    assert.equal(toPublicError(known), known);
  });

  it('writes logEvent as one JSON line with only the given safe metadata', () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      logEvent('tool_failed', { tool: 'get_schedule', code: 'INTERNAL', status: 500 });
    } finally {
      setLogSink(undefined);
    }
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('\n'));
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'tool_failed');
    assert.equal(parsed.tool, 'get_schedule');
    assert.equal(parsed.code, 'INTERNAL');
    assert.equal(parsed.status, 500);
    assert.equal(typeof parsed.ts, 'string');
  });

  it('writes debug events only when debug is enabled', () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      logEvent('cache_hit', { fresh: true }, 'debug');
      assert.equal(lines.length, 0);
    } finally {
      setLogSink(undefined);
    }
  });
});
