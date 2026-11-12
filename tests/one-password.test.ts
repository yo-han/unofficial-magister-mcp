import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { readOnePasswordOtp } from '../src/one-password.js';
import { PublicError } from '../src/errors.js';

it('reads a fresh OTP with explicit account and without forwarding Magister credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magister-op-'));
  const command = join(dir, 'op');
  const capture = join(dir, 'args.json');
  const username = process.env.MAGISTER_USER;
  const password = process.env.MAGISTER_PASS;
  try {
    process.env.MAGISTER_USER = 'synthetic-user';
    process.env.MAGISTER_PASS = 'synthetic-password';
    await writeFile(
      command,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2), user:process.env.MAGISTER_USER, pass:process.env.MAGISTER_PASS}));
process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'code'))}, 'utf8'));
`,
      { mode: 0o700 }
    );
    const config = {
      command,
      account: 'example.1password.com',
      reference: 'op://Private/Magister/OTP?attribute=otp',
    };
    await writeFile(join(dir, 'code'), '123456\n');
    assert.equal(await readOnePasswordOtp(config), '123456');
    await writeFile(join(dir, 'code'), '654321\n');
    assert.equal(await readOnePasswordOtp(config), '654321');
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {
      args: ['--account', config.account, 'read', config.reference],
    });
    for (const output of ['otpauth://totp/secret-seed', '123456\n654321', 'abcdef']) {
      await writeFile(join(dir, 'code'), output);
      await assert.rejects(readOnePasswordOtp(config), { code: 'MFA_UNAVAILABLE' });
    }
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.stderr.write('synthetic-secret-error');process.exit(1);`
    );
    await assert.rejects(readOnePasswordOtp(config), (error) => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.code, 'MFA_UNAVAILABLE');
      assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    if (username === undefined) delete process.env.MAGISTER_USER;
    else process.env.MAGISTER_USER = username;
    if (password === undefined) delete process.env.MAGISTER_PASS;
    else process.env.MAGISTER_PASS = password;
    await rm(dir, { recursive: true, force: true });
  }
});
