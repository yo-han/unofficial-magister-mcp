import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PublicError } from './errors.js';

/**
 * Private, per-account session storage.
 *
 * Layout: <stateDir>/<hash(school, profile)>/session.json
 *
 * Directories are 0700 and the session file 0600, both owned by the current
 * user. Existing paths are opened with O_NOFOLLOW and checked through the
 * handle (fstat/fchmod) so a planted symlink is refused instead of followed.
 * The file holds unencrypted bearer state; it is not a vault.
 */

const SESSION_FILE = 'session.json';
const TMP_FILE = /^\.session\..+\.tmp$/;
const MAX_SESSION_BYTES = 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_POSIX = process.platform !== 'win32';
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

const StorageStateSchema = z.object({
  cookies: z.array(z.record(z.string(), z.unknown())),
  origins: z.array(z.record(z.string(), z.unknown())),
});

export const StoredSessionSchema = z.strictObject({
  version: z.literal(1),
  schoolOrigin: z.string(),
  profileHash: z.string(),
  accountPersonId: z.number().int().positive(),
  childId: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  savedAt: z.iso.datetime(),
  accessToken: z.string().min(1),
  accessTokenExp: z.number().nullable(),
  storageState: StorageStateSchema,
});

export type StoredSession = z.infer<typeof StoredSessionSchema>;

export interface AccountStoreOptions {
  stateDir: string;
  schoolOrigin: string;
  profile: string;
}

function unsafe(): PublicError {
  return new PublicError('STORAGE_UNSAFE');
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Owner and type checks through an already-open handle. */
async function verifyHandle(handle: FileHandle, kind: 'dir' | 'file', mode: number) {
  const stats = await handle.stat();
  const rightType = kind === 'dir' ? stats.isDirectory() : stats.isFile();
  if (!rightType) throw unsafe();
  if (!IS_POSIX) return stats;
  if (stats.uid !== process.getuid?.()) throw unsafe();
  if ((stats.mode & 0o777) !== mode) await handle.chmod(mode);
  return stats;
}

/**
 * Opens an existing path without following a final symlink and checks it.
 * Returns false if it does not exist.
 */
async function checkExistingDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (!IS_POSIX) return true;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw unsafe();
  }
  try {
    await verifyHandle(handle, 'dir', DIR_MODE);
  } finally {
    await handle.close();
  }
  return true;
}

async function ensurePrivateDir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIR_MODE });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (!(await checkExistingDir(path))) throw unsafe();
}

async function syncDir(path: string): Promise<void> {
  if (!IS_POSIX) return;
  const handle = await open(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AccountStore {
  readonly stateDir: string;
  readonly accountDir: string;
  readonly sessionPath: string;
  readonly schoolOrigin: string;
  /** Hash of school + profile; used as directory name and session metadata. */
  readonly profileHash: string;

  constructor(options: AccountStoreOptions) {
    this.stateDir = options.stateDir;
    this.schoolOrigin = options.schoolOrigin;
    this.profileHash = createHash('sha256')
      .update(`v1\0${options.schoolOrigin}\0${options.profile}`)
      .digest('hex')
      .slice(0, 32);
    this.accountDir = join(this.stateDir, this.profileHash);
    this.sessionPath = join(this.accountDir, SESSION_FILE);
  }

  /**
   * Reads the stored session. Returns null when there is none or it is
   * unreadable/invalid; throws STORAGE_UNSAFE when the location is not private.
   */
  async readSession(): Promise<StoredSession | null> {
    if (!(await checkExistingDir(this.stateDir))) return null;
    if (!(await checkExistingDir(this.accountDir))) return null;

    let handle: FileHandle;
    try {
      handle = await open(this.sessionPath, constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw unsafe();
    }
    let raw: string;
    try {
      const stats = await verifyHandle(handle, 'file', FILE_MODE);
      if (stats.size > MAX_SESSION_BYTES) return null;
      raw = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = StoredSessionSchema.safeParse(json);
    if (!parsed.success) return null;
    if (
      parsed.data.schoolOrigin !== this.schoolOrigin ||
      parsed.data.profileHash !== this.profileHash
    ) {
      return null;
    }
    return parsed.data;
  }

  async currentSessionId(): Promise<string | null> {
    return (await this.readSession())?.sessionId ?? null;
  }

  /** Atomically writes the session (exclusive random temp file, fsync, rename). */
  async writeSession(session: StoredSession): Promise<void> {
    await this.commit(session, async () => true);
  }

  /**
   * Writes only if the stored session still has `expectedSessionId` right
   * before the rename. Returns false (and writes nothing) otherwise, so a
   * refresh that finishes after a logout cannot recreate the session.
   */
  async replaceSession(session: StoredSession, expectedSessionId: string): Promise<boolean> {
    return this.commit(session, async () => (await this.currentSessionId()) === expectedSessionId);
  }

  private async commit(
    session: StoredSession,
    shouldCommit: () => Promise<boolean>
  ): Promise<boolean> {
    const body = JSON.stringify(StoredSessionSchema.parse(session));
    if (!(await shouldCommit())) return false;

    await mkdir(dirname(this.stateDir), { recursive: true });
    await ensurePrivateDir(this.stateDir);
    await ensurePrivateDir(this.accountDir);

    const tmpPath = join(this.accountDir, `.session.${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(tmpPath, 'wx', FILE_MODE);
    let committed = false;
    try {
      await verifyHandle(handle, 'file', FILE_MODE);
      await handle.writeFile(body, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      if (!(await shouldCommit())) return false;
      await rename(tmpPath, this.sessionPath);
      committed = true;
      await syncDir(this.accountDir);
      return true;
    } finally {
      await handle.close().catch(() => undefined);
      if (!committed) await unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * Removes the session and the account directory. Symlinks are removed, never
   * followed. Returns false if there was nothing to remove.
   */
  async deleteAccount(): Promise<boolean> {
    let info;
    try {
      info = await lstat(this.accountDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await unlink(this.accountDir);
      return true;
    }
    for (const name of await readdir(this.accountDir)) {
      if (name === SESSION_FILE || TMP_FILE.test(name)) {
        await unlink(join(this.accountDir, name));
      }
    }
    try {
      await rmdir(this.accountDir);
    } catch {
      // Something we did not create is in there; leave it rather than delete it.
      throw unsafe();
    }
    return true;
  }
}
