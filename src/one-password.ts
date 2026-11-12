import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { PublicError } from './errors.js';

const run = promisify(execFile);

/** Read a fresh code only when challenged; never return CLI errors or seed data. */
export async function readOnePasswordOtp(otp: NonNullable<Config['otp']>): Promise<string> {
  const args = [...(otp.account ? ['--account', otp.account] : []), 'read', otp.reference];
  const env = { ...process.env };
  delete env.MAGISTER_USER;
  delete env.MAGISTER_PASS;
  try {
    const { stdout } = await run(otp.command, args, { env, timeout: 30_000, maxBuffer: 1024 });
    const code = stdout.trim();
    if (!/^\d{6,8}$/.test(code)) throw new Error('Invalid code');
    return code;
  } catch {
    throw new PublicError('MFA_UNAVAILABLE');
  }
}
