import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliIo, run } from '../src/cli.js';
import { setLogSink } from '../src/logger.js';
import { AccountStore } from '../src/storage.js';

const dirs: string[] = [];

afterEach(async () => {
  setLogSink(undefined);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env };
  return { value, out: () => out.join(''), err: () => err.join('') };
}

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'magister-cli-'));
  dirs.push(dir);
  return join(dir, 'state');
}

describe('cli', () => {
  it('prints help with variable names but no values', async () => {
    const cap = io({ MAGISTER_PASS: 'cli-pass-sentinel' });
    assert.equal(await run(['--help'], cap.value), 0);
    assert.match(cap.out(), /login/);
    assert.match(cap.out(), /MAGISTER_PASS/);
    assert.equal(cap.out().includes('cli-pass-sentinel'), false);
  });

  it('rejects unknown commands and extra arguments with exit code 2', async () => {
    for (const argv of [['bogus'], ['login', 'extra']]) {
      const cap = io();
      assert.equal(await run(argv, cap.value), 2);
      assert.match(cap.err(), /^Usage:/);
      assert.equal(cap.out(), '');
    }
  });

  it('logout succeeds when there is nothing to remove', async () => {
    setLogSink(() => undefined);
    const cap = io({ MAGISTER_SCHOOL: 'mencia', MAGISTER_STATE_DIR: await stateDir() });
    assert.equal(await run(['logout'], cap.value), 0);
    assert.match(cap.out(), /No local session found/);
    assert.match(cap.out(), /server-side tokens are not revoked/);
  });

  it('logout removes the stored session of this school and profile', async () => {
    setLogSink(() => undefined);
    const dir = await stateDir();
    const store = new AccountStore({
      stateDir: dir,
      schoolOrigin: 'https://mencia.magister.net',
      profile: 'default',
    });
    await store.writeSession({
      version: 1,
      schoolOrigin: store.schoolOrigin,
      profileHash: store.profileHash,
      accountPersonId: 1,
      sessionId: 'cli-session',
      savedAt: new Date().toISOString(),
      accessToken: 'cli-token',
      accessTokenExp: null,
      storageState: { cookies: [], origins: [] },
    });
    const cap = io({ MAGISTER_SCHOOL: 'mencia', MAGISTER_STATE_DIR: dir });
    assert.equal(await run(['logout'], cap.value), 0);
    assert.match(cap.out(), /Local session removed/);
    assert.equal(existsSync(store.accountDir), false);
  });

  it('reports invalid configuration by variable name only', async () => {
    setLogSink(() => undefined);
    const cap = io({ MAGISTER_SCHOOL: 'https://evil.example/secret-path' });
    assert.equal(await run(['logout'], cap.value), 1);
    assert.equal(
      cap.err(),
      '[CONFIG_INVALID] The server configuration is invalid. (MAGISTER_SCHOOL)\n'
    );
  });

  it('refuses login when session persistence is disabled, before opening a browser', async () => {
    setLogSink(() => undefined);
    const cap = io({ MAGISTER_SCHOOL: 'mencia', MAGISTER_PERSIST_SESSION: 'false' });
    assert.equal(await run(['login'], cap.value), 1);
    assert.match(cap.err(), /\[CONFIG_INVALID\].*MAGISTER_PERSIST_SESSION/);
  });
});
