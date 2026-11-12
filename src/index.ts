import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, PACKAGE_ROOT } from './config.js';
import { PublicError, toPublicError } from './errors.js';
import { logEvent, setDebugLogging } from './logger.js';
import { MagisterClient } from './magister.js';
import { createServer } from './server.js';
import { AccountStore } from './storage.js';

/** Pre-hardening state files; ignored, never imported. */
const LEGACY_FILES = ['.auth-state.json', '.schedule-cache.json'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  const publicError = toPublicError(error);
  logEvent('config_invalid', publicError.variable ? { variable: publicError.variable } : {});
  process.stderr.write(`${publicError.toPublicText()}\n`);
  process.exit(1);
}
setDebugLogging(config.debug);

let client: MagisterClient | null = null;
let ready: Promise<void> | null = null;

const store = config.persistSession
  ? new AccountStore({
      stateDir: config.stateDir,
      schoolOrigin: config.schoolOrigin,
      profile: config.profile,
    })
  : null;

if (LEGACY_FILES.some((name) => existsSync(join(PACKAGE_ROOT, name)))) {
  logEvent('legacy_state_present', {}, 'warn');
}

const server = createServer({
  version: pkg.version,
  clientFactory: () => {
    if (config.authMode !== 'password') throw new PublicError('NOT_LOGGED_IN');
    const magister = new MagisterClient(config, store);
    client = magister;
    ready = magister.init();
    return {
      getSchedule: async (date) => (await ready, magister.getSchedule(date)),
      getWeekSchedule: async (dates) => (await ready, magister.getWeekSchedule(dates)),
      getFirstClass: async (date) => (await ready, magister.getFirstClass(date)),
      getLastClass: async (date) => (await ready, magister.getLastClass(date)),
    };
  },
});

async function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  logEvent('shutdown', { signal });
  if (client) await client.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const transport = new StdioServerTransport();
await server.connect(transport);
logEvent('server_started');
