import assert from 'node:assert/strict';
import { it } from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MagisterClient } from '../../src/magister.js';
import { createHarness } from '../fixtures/harness.js';
import { TEST_USERNAME, TEST_PASSWORD } from '../fixtures/magister-routes.js';

it('reads 1Password credentials only for the login form and reuses the saved session', async () => {
  const h = await createHarness(
    {
      MAGISTER_AUTH_MODE: 'password',
      MAGISTER_USER: 'op://Private/Magister/username',
      MAGISTER_PASS: 'op://Private/Magister/password',
    },
    { loginBehaviour: 'manual' }
  );
  const command = join(h.stateDir, 'op');
  const calls = join(h.stateDir, 'op-calls');
  await writeFile(
    command,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'read\\n');
process.stdout.write(process.argv.at(-1).endsWith('/username') ? ${JSON.stringify(TEST_USERNAME)} : ${JSON.stringify(TEST_PASSWORD)});
`,
    { mode: 0o700 }
  );
  const deps = { ...h.deps, config: { ...h.deps.config, onePassword: { command } } };
  let client = new MagisterClient(deps);
  try {
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
    await client.getSchedule('2026-11-12');
    assert.equal(await readFile(calls, 'utf8'), 'read\nread\n');
    assert.equal(h.state.loginPosts.length, 1);
    await client.close();
    client = new MagisterClient(deps);
    await client.getSchedule('2026-11-12');
    assert.equal(await readFile(calls, 'utf8'), 'read\nread\n');
    assert.deepEqual(h.state.external, []);
  } finally {
    await client.close();
    await h.cleanup();
  }
});

it('logs in with modern Magister buttons and logs in again after SSO expires', async () => {
  const h = await createHarness(
    { MAGISTER_AUTH_MODE: 'password', MAGISTER_USER: TEST_USERNAME, MAGISTER_PASS: TEST_PASSWORD },
    { loginBehaviour: 'manual', modernButtons: true, passkeyChoice: true }
  );
  let client = new MagisterClient(h.deps);
  try {
    await client.getSchedule('2026-11-12');
    await client.close();
    h.state.issuedTokens.clear();
    h.state.ssoSessions.clear();
    client = new MagisterClient(h.deps);
    assert.deepEqual(await client.getSchedule('2026-11-12'), []);
    assert.equal(h.state.loginPosts.length, 2);
    assert.ok(h.launches.every(({ headless }) => headless));
    assert.deepEqual(h.state.external, []);
  } finally {
    await client.close();
    await h.cleanup();
  }
});

it(
  'refreshes password-mode tokens through an existing SSO session without another credential submission',
  { timeout: 15000 },
  async () => {
    const harness = await createHarness(
      {
        MAGISTER_AUTH_MODE: 'password',
        MAGISTER_USER: TEST_USERNAME,
        MAGISTER_PASS: TEST_PASSWORD,
      },
      { loginBehaviour: 'manual' }
    );
    let client = new MagisterClient(harness.deps);
    try {
      await client.getSchedule('2026-11-12');
      await client.close();
      const before = harness.state.authorizeCalls;
      harness.state.issuedTokens.clear();
      // A valid SSO session must not try to read credentials, even if the CLI is unavailable.
      client = new MagisterClient({
        ...harness.deps,
        config: {
          ...harness.deps.config,
          username: 'op://Private/Magister/username',
          password: 'op://Private/Magister/password',
          onePassword: { command: '/nonexistent/op' },
        },
      });
      assert.deepEqual(await client.getSchedule('2026-11-12'), []);
      assert.equal(harness.state.authorizeCalls, before + 1);
      assert.equal(harness.state.loginPosts.length, 1);
      assert.deepEqual(harness.state.external, []);
    } finally {
      await client.close();
      await harness.cleanup();
    }
  }
);

it(
  'never persists a refreshed token when the SSO identity changed',
  { timeout: 15000 },
  async () => {
    const harness = await createHarness(
      {
        MAGISTER_AUTH_MODE: 'password',
        MAGISTER_USER: TEST_USERNAME,
        MAGISTER_PASS: TEST_PASSWORD,
      },
      { loginBehaviour: 'manual' }
    );
    let client = new MagisterClient(harness.deps);
    try {
      await client.getSchedule('2026-11-12');
      await client.close();
      const before = await harness.store.readSession();
      assert.ok(before);
      harness.state.options.accountPersonId += 1;
      harness.state.issuedTokens.clear();
      client = new MagisterClient(harness.deps);
      await assert.rejects(client.getSchedule('2026-11-12'), { code: 'SESSION_MISMATCH' });
      const after = await harness.store.readSession();
      assert.ok(after);
      assert.equal(after.accessToken, before.accessToken);
      assert.equal(after.accountPersonId, before.accountPersonId);
    } finally {
      await client.close();
      await harness.cleanup();
    }
  }
);
