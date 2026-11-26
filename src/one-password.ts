import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { PublicError } from './errors.js';

const run = promisify(execFile);

/** Resolve references only for a real login; preserve password whitespace. */
export async function resolveLoginCredentials(
  config: Config
): Promise<{ username: string; password: string }> {
  if (!config.username) throw new PublicError('CONFIG_INVALID', 'MAGISTER_USER');
  if (!config.password) throw new PublicError('CONFIG_INVALID', 'MAGISTER_PASS');
  const cli = config.onePassword ?? { command: 'op' };
  const env = { ...process.env };
  delete env.MAGISTER_USER;
  delete env.MAGISTER_PASS;
  const resolve = async (value: string): Promise<string> => {
    if (!value.startsWith('op://')) return value;
    try {
      const args = [
        ...(cli.account ? ['--account', cli.account] : []),
        'read',
        '--no-newline',
        value,
      ];
      const { stdout } = await run(cli.command, args, { env, timeout: 60_000, maxBuffer: 16_384 });
      if (!stdout) throw new Error('Empty credential');
      return stdout;
    } catch {
      throw new PublicError('CREDENTIALS_UNAVAILABLE');
    }
  };
  // Sequential reads avoid concurrent authorization prompts.
  const username = await resolve(config.username);
  const password = await resolve(config.password);
  return { username, password };
}

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
