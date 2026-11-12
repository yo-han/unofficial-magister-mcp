import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** These tests exercise the compiled server; run `npm run build` first. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'dist', 'index.js');
const SENTINEL = 'raw-pass-sentinel-41d2';

function requireBuild() {
  assert.ok(existsSync(ENTRY), 'dist/index.js is missing; run `npm run build` first');
}

describe('compiled server over stdio', { timeout: 60_000 }, () => {
  it('passes the protocol smoke script', () => {
    requireBuild();
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'smoke.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^ok - without a session get_schedule is NOT_LOGGED_IN$/m);
    assert.match(result.stdout, /does not prove real Magister authentication/);
  });

  it('writes only JSON-RPC messages to stdout', async () => {
    requireBuild();
    const dir = await mkdtemp(join(tmpdir(), 'magister-raw-'));
    try {
      const child = spawn(process.execPath, [ENTRY], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? '',
          MAGISTER_SCHOOL: 'smoke-test',
          MAGISTER_STATE_DIR: join(dir, 'state'),
          MAGISTER_PASS: SENTINEL,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_schedule', arguments: { date: 'today' } },
      });
      const deadline = Date.now() + 15_000;
      while (!stdout.includes('"id":3') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      await exited;

      const lines = stdout.split('\n').filter((line) => line.length > 0);
      assert.equal(lines.length, 3, stdout);
      for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
      assert.match(lines[2], /NOT_LOGGED_IN/);
      assert.equal(stdout.includes(SENTINEL) || stderr.includes(SENTINEL), false);
      // Closing stdin shuts the server down cleanly.
      assert.match(stderr, /"event":"shutdown","reason":"stdin"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
