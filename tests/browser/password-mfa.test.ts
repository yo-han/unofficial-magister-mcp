import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { MagisterClient } from '../../src/magister.js';
import { PublicError } from '../../src/errors.js';
import { createHarness } from '../fixtures/harness.js';
import { TEST_USERNAME, TEST_PASSWORD } from '../fixtures/magister-routes.js';

const env = {
  MAGISTER_AUTH_MODE: 'password',
  MAGISTER_USER: TEST_USERNAME,
  MAGISTER_PASS: TEST_PASSWORD,
};
const fixture = {
  loginBehaviour: 'manual' as const,
  modernButtons: true,
  passkeyChoice: true,
  mfaRequired: true,
};

for (const mfaAutoSubmit of [false, true]) {
  it(`uses a fresh MFA code again after SSO expiry (auto submit: ${mfaAutoSubmit})`, async () => {
    const h = await createHarness(env, { ...fixture, mfaAutoSubmit });
    let reads = 0;
    h.deps.getOtp = async () => {
      reads++;
      return h.state.options.mfaCode;
    };
    let client = new MagisterClient(h.deps);
    try {
      await client.getSchedule('2026-11-12');
      const before = await h.store.readSession();
      assert.ok(before);
      await client.close();
      h.state.ssoSessions.clear();
      h.state.issuedTokens.clear();
      h.state.options.mfaCode = '654321';
      client = new MagisterClient(h.deps);
      assert.deepEqual(await client.getSchedule('2026-11-12'), []);
      assert.equal(reads, 2);
      assert.deepEqual(h.state.otpPosts, ['123456', '654321']);
      const after = await h.store.readSession();
      assert.ok(after);
      assert.equal(after.accountPersonId, before.accountPersonId);
      assert.ok(h.launches.every(({ headless }) => headless));
      assert.deepEqual(h.state.external, []);
    } finally {
      await client.close();
      await h.cleanup();
    }
  });
}

for (const kind of ['missing', 'unavailable', 'seed'] as const) {
  it(`fails safely when the MFA provider is ${kind}`, async () => {
    const h = await createHarness(env, fixture);
    if (kind === 'unavailable')
      h.deps.getOtp = async () => {
        throw new PublicError('MFA_UNAVAILABLE');
      };
    if (kind === 'seed') h.deps.getOtp = async () => 'otpauth://totp/synthetic-secret-seed';
    const client = new MagisterClient(h.deps);
    try {
      await assert.rejects(client.getSchedule('2026-11-12'), {
        code: kind === 'missing' ? 'MFA_REQUIRED' : 'MFA_UNAVAILABLE',
      });
      assert.deepEqual(h.state.otpPosts, []);
      assert.equal(await h.store.readSession(), null);
    } finally {
      await client.close();
      await h.cleanup();
    }
  });
}

it('never requests or submits an OTP on an allowed SSO origin', async () => {
  const mfaOrigin = 'https://sso.fixture-school.example';
  const h = await createHarness(
    { ...env, MAGISTER_SSO_ORIGINS: mfaOrigin },
    { ...fixture, mfaOrigin }
  );
  let reads = 0;
  h.deps.getOtp = async () => {
    reads++;
    return '123456';
  };
  const client = new MagisterClient(h.deps);
  try {
    await assert.rejects(client.getSchedule('2026-11-12'), { code: 'ORIGIN_VIOLATION' });
    assert.equal(reads, 0);
    assert.deepEqual(h.state.otpPosts, []);
    assert.equal(await h.store.readSession(), null);
  } finally {
    await client.close();
    await h.cleanup();
  }
});

it('checks the origin again when navigation occurs while 1Password is reading', async () => {
  const foreign = 'https://sso.fixture-school.example';
  const h = await createHarness({ ...env, MAGISTER_SSO_ORIGINS: foreign }, fixture);
  let context: BrowserContext;
  const prepare = h.deps.prepareContext!;
  h.deps.prepareContext = async (browserContext) => {
    context = browserContext;
    await prepare(browserContext);
    await browserContext.route(`${foreign}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<input id="token"><button>Doorgaan</button>',
      })
    );
  };
  h.deps.getOtp = async () => {
    await context.pages()[0].goto(foreign);
    return '123456';
  };
  const client = new MagisterClient(h.deps);
  try {
    await assert.rejects(client.getSchedule('2026-11-12'), { code: 'ORIGIN_VIOLATION' });
    assert.deepEqual(h.state.otpPosts, []);
    assert.equal(await h.store.readSession(), null);
  } finally {
    await client.close();
    await h.cleanup();
  }
});
