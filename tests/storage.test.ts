import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from '../src/config.js';
import { PublicError } from '../src/errors.js';
import { AccountStore, StoredSession } from '../src/storage.js';

const posix = process.platform !== 'win32';
const SCHOOL = 'https://fixture-school.magister.net';

function sessionFor(store: AccountStore, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    version: 1,
    schoolOrigin: SCHOOL,
    profileHash: store.profileHash,
    accountPersonId: 1001,
    childId: 2002,
    sessionId: 'session-a',
    savedAt: '2026-11-12T10:00:00.000Z',
    accessToken: 'token-value',
    accessTokenExp: 1_900_000_000,
    storageState: { cookies: [], origins: [] },
    ...overrides,
  };
}

function sha(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mode(path: string) {
  return statSync(path).mode & 0o777;
}

async function expectUnsafe(promise: Promise<unknown>) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof PublicError && error.code === 'STORAGE_UNSAFE'
  );
}

describe('AccountStore', { skip: !posix && 'POSIX permissions only' }, () => {
  let root: string;
  let stateDir: string;
  let previousUmask: number;
  let packageRootBefore: string[];

  beforeEach(async () => {
    packageRootBefore = readdirSync(PACKAGE_ROOT).sort();
    previousUmask = process.umask(0o022);
    root = await mkdtemp(join(tmpdir(), 'magister-store-'));
    stateDir = join(root, 'state');
  });

  afterEach(async () => {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(readdirSync(PACKAGE_ROOT).sort(), packageRootBefore);
  });

  it('writes the session 0600 inside 0700 directories under umask 022', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await store.writeSession(sessionFor(store));
    const sessionPath = store.sessionPath;
    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
    assert.equal(mode(stateDir), 0o700);
    assert.deepEqual(await store.readSession(), sessionFor(store));
    // No temporary files left behind.
    assert.deepEqual(readdirSync(dirname(sessionPath)), ['session.json']);
  });

  it('names account directories by a hash that does not reveal school or profile', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent@example' });
    await store.writeSession(sessionFor(store));
    const name = readdirSync(stateDir)[0];
    assert.match(name, /^[0-9a-f]{32}$/);
    assert.equal(store.sessionPath.includes('parent'), false);
    assert.equal(store.sessionPath.includes('fixture-school'), false);
  });

  it('repairs pre-existing directories and files with unsafe modes', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    mkdirSync(dirname(store.sessionPath), { recursive: true, mode: 0o755 });
    chmodSync(stateDir, 0o755);
    chmodSync(dirname(store.sessionPath), 0o755);
    writeFileSync(store.sessionPath, JSON.stringify(sessionFor(store)), { mode: 0o644 });
    chmodSync(store.sessionPath, 0o644);

    assert.deepEqual(await store.readSession(), sessionFor(store));
    assert.equal(mode(store.sessionPath), 0o600);
    assert.equal(mode(dirname(store.sessionPath)), 0o700);
    assert.equal(mode(stateDir), 0o700);
  });

  it('refuses a symlinked account directory and leaves the target untouched', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    const victimDir = join(root, 'victim');
    mkdirSync(victimDir, { mode: 0o755 });
    writeFileSync(join(victimDir, 'keep.txt'), 'user data');
    const before = sha(join(victimDir, 'keep.txt'));
    mkdirSync(stateDir, { mode: 0o700 });
    symlinkSync(victimDir, dirname(store.sessionPath));

    await expectUnsafe(store.writeSession(sessionFor(store)));
    await expectUnsafe(store.readSession());
    assert.equal(sha(join(victimDir, 'keep.txt')), before);
    assert.deepEqual(readdirSync(victimDir), ['keep.txt']);
    assert.equal(mode(victimDir), 0o755);
  });

  it('refuses a symlinked state directory', async () => {
    const victimDir = join(root, 'victim');
    mkdirSync(victimDir, { mode: 0o755 });
    symlinkSync(victimDir, stateDir);
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await expectUnsafe(store.writeSession(sessionFor(store)));
    assert.deepEqual(readdirSync(victimDir), []);
    assert.equal(mode(victimDir), 0o755);
  });

  it('refuses a symlinked session file and leaves the target untouched', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    mkdirSync(dirname(store.sessionPath), { recursive: true, mode: 0o700 });
    const victim = join(root, 'victim.json');
    writeFileSync(victim, '{"user":"data"}', { mode: 0o644 });
    const before = sha(victim);
    symlinkSync(victim, store.sessionPath);

    await expectUnsafe(store.readSession());
    assert.equal(sha(victim), before);
    assert.equal(mode(victim), 0o644);

    // Deleting removes the link, never the target.
    await store.deleteAccount();
    assert.equal(existsSync(victim), true);
    assert.equal(sha(victim), before);
  });

  it('keeps two profiles in separate directories', async () => {
    const a = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'child-a' });
    const b = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'child-b' });
    assert.notEqual(dirname(a.sessionPath), dirname(b.sessionPath));
    await a.writeSession(sessionFor(a, { sessionId: 'a' }));
    assert.equal(await b.readSession(), null);
    await b.writeSession(sessionFor(b, { sessionId: 'b' }));
    assert.equal((await a.readSession())?.sessionId, 'a');
    assert.equal((await b.readSession())?.sessionId, 'b');
  });

  it('keeps two schools with the same profile apart', () => {
    const a = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'p' });
    const b = new AccountStore({
      stateDir,
      schoolOrigin: 'https://other-school.magister.net',
      profile: 'p',
    });
    assert.notEqual(dirname(a.sessionPath), dirname(b.sessionPath));
  });

  it('treats corrupt or foreign session files as no session', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await store.writeSession(sessionFor(store));
    writeFileSync(store.sessionPath, '{not json');
    assert.equal(await store.readSession(), null);
    writeFileSync(
      store.sessionPath,
      JSON.stringify(sessionFor(store, { schoolOrigin: 'https://other.magister.net' }))
    );
    assert.equal(await store.readSession(), null);
    writeFileSync(store.sessionPath, JSON.stringify(sessionFor(store, { profileHash: 'x' })));
    assert.equal(await store.readSession(), null);
    writeFileSync(store.sessionPath, JSON.stringify({ ...sessionFor(store), version: 2 }));
    assert.equal(await store.readSession(), null);
  });

  it('returns no session when nothing was stored, without creating directories', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    assert.equal(await store.readSession(), null);
    assert.equal(await store.currentSessionId(), null);
    assert.equal(existsSync(stateDir), false);
  });

  it('deletes the account directory and is idempotent', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await store.writeSession(sessionFor(store));
    writeFileSync(join(dirname(store.sessionPath), '.session.leftover.tmp'), 'x');
    assert.equal(await store.deleteAccount(), true);
    assert.equal(existsSync(dirname(store.sessionPath)), false);
    assert.equal(await store.deleteAccount(), false);
  });

  it('only replaces a session whose id still matches', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await store.writeSession(sessionFor(store, { sessionId: 'one' }));
    assert.equal(await store.currentSessionId(), 'one');
    assert.equal(
      await store.replaceSession(sessionFor(store, { sessionId: 'one', accessToken: 't2' }), 'one'),
      true
    );
    assert.equal((await store.readSession())?.accessToken, 't2');
    assert.equal(await store.replaceSession(sessionFor(store), 'other'), false);
    await store.deleteAccount();
    assert.equal(await store.replaceSession(sessionFor(store, { sessionId: 'one' }), 'one'), false);
    assert.equal(existsSync(store.sessionPath), false);
  });

  it('refuses a session file that is too large', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    await store.writeSession(sessionFor(store));
    writeFileSync(store.sessionPath, 'x'.repeat(2 * 1024 * 1024));
    assert.equal(await store.readSession(), null);
  });

  it('refuses a directory where the session file should be', async () => {
    const store = new AccountStore({ stateDir, schoolOrigin: SCHOOL, profile: 'parent' });
    mkdirSync(store.sessionPath, { recursive: true, mode: 0o700 });
    await expectUnsafe(store.readSession());
    assert.equal(lstatSync(store.sessionPath).isDirectory(), true);
  });
});
