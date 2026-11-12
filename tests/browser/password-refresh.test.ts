import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MagisterClient } from '../../src/magister.js';
import { createHarness } from '../fixtures/harness.js';
import { TEST_USERNAME, TEST_PASSWORD } from '../fixtures/magister-routes.js';

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
      client = new MagisterClient(harness.deps);
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
