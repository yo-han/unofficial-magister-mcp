import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../../src/config.js';
import type { ClientDeps } from '../../src/magister.js';
import { AccountStore } from '../../src/storage.js';
import {
  createFixtureState,
  FixtureOptions,
  FixtureState,
  installFixture,
} from './magister-routes.js';

export interface Harness {
  deps: ClientDeps;
  state: FixtureState;
  store: AccountStore;
  stateDir: string;
  launches: { headless: boolean }[];
  cleanup: () => Promise<void>;
}

export const FAST_TIMEOUTS = {
  loginMs: 6_000,
  refreshMs: 4_000,
  apiMs: 5_000,
  stepMs: 3_000,
};

/** A client setup that talks only to the route fixture, with a private temp state dir. */
export async function createHarness(
  env: Record<string, string> = {},
  fixture: Partial<FixtureOptions> = {},
  shared?: { stateDir: string; state: FixtureState }
): Promise<Harness> {
  const stateDir = shared?.stateDir ?? (await mkdtemp(join(tmpdir(), 'magister-browser-')));
  const state = shared?.state ?? createFixtureState(fixture);
  const config = loadConfig({
    MAGISTER_SCHOOL: 'fixture-school',
    MAGISTER_STATE_DIR: stateDir,
    MAGISTER_PROFILE: 'synthetic-profile',
    ...env,
  });
  const store = new AccountStore({
    stateDir: config.stateDir,
    schoolOrigin: config.schoolOrigin,
    profile: config.profile,
  });
  const launches: { headless: boolean }[] = [];
  const deps: ClientDeps = {
    config,
    store: config.persistSession ? store : null,
    // Always headless in tests; record what production would have asked for.
    launchBrowser: async (headless) => {
      launches.push({ headless });
      return chromium.launch({ headless: true });
    },
    prepareContext: (context) => installFixture(context, state),
    timeouts: FAST_TIMEOUTS,
  };
  return {
    deps,
    state,
    store,
    stateDir,
    launches,
    cleanup: async () => {
      if (!shared) await rm(stateDir, { recursive: true, force: true });
    },
  };
}
