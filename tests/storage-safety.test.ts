import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { loadConfig, PACKAGE_ROOT } from '../src/config.js';
import { AccountStore } from '../src/storage.js';

const schoolOrigin = 'https://fixture-school.magister.net';
const profile = 'storage-review';
const run = promisify(execFile);

it('rejects checkout-contained state paths whose directory starts with two dots', () => {
  assert.throws(
    () =>
      loadConfig({
        MAGISTER_SCHOOL: 'fixture-school',
        MAGISTER_STATE_DIR: join(PACKAGE_ROOT, '..cache-state'),
      }),
    { code: 'CONFIG_INVALID' }
  );
});

it(
  'logout refuses a symlinked state root without deleting the target session',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'magister-logout-review-'));
    try {
      const target = join(root, 'target');
      const link = join(root, 'state-link');
      const targetStore = new AccountStore({ stateDir: target, schoolOrigin, profile });
      await mkdir(targetStore.accountDir, { recursive: true, mode: 0o700 });
      await writeFile(targetStore.sessionPath, 'untouched synthetic fixture');
      await symlink(target, link, 'dir');
      const store = new AccountStore({ stateDir: link, schoolOrigin, profile });
      await assert.rejects(store.deleteAccount(), { code: 'STORAGE_UNSAFE' });
      assert.equal(await readFile(targetStore.sessionPath, 'utf8'), 'untouched synthetic fixture');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it(
  'refuses a FIFO session file without waiting for a writer',
  { skip: process.platform === 'win32', timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'magister-fifo-review-'));
    try {
      const store = new AccountStore({ stateDir: root, schoolOrigin, profile });
      await mkdir(store.accountDir, { mode: 0o700 });
      execFileSync('mkfifo', [store.sessionPath]);
      const code = `import {AccountStore} from './src/storage.ts';\nconst store=new AccountStore({stateDir:process.env.TEST_STATE_DIR,schoolOrigin:'https://fixture-school.magister.net',profile:'storage-review'});\ntry { await store.readSession(); console.log('unexpected success'); } catch(error) { console.log(error.code); }`;
      const { stdout } = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code],
        {
          cwd: PACKAGE_ROOT,
          env: { ...process.env, TEST_STATE_DIR: root },
          timeout: 2000,
        }
      );
      assert.equal(stdout.trim(), 'STORAGE_UNSAFE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
