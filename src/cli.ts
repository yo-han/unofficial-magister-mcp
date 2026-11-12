import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { interactiveLogin } from './auth.js';
import { Config, loadConfig, PACKAGE_ROOT } from './config.js';
import { PublicError, toPublicError } from './errors.js';
import { logEvent, SafeTag, setDebugLogging } from './logger.js';
import { defaultClientDeps, MagisterClient } from './magister.js';
import { createServer } from './server.js';
import { AccountStore } from './storage.js';

/** Pre-hardening state files; ignored, never imported. */
const LEGACY_FILES = ['.auth-state.json', '.schedule-cache.json'];

const USAGE = `Usage: unofficial-magister-mcp [command]

Commands:
  (none)      Start the MCP server on stdio
  login       Open a browser window to log in to Magister and store the session
  logout      Remove the locally stored session (server-side tokens are not revoked)
  --help      Show this help
  --version   Show the version

Environment:
  MAGISTER_SCHOOL (required), MAGISTER_PROFILE, MAGISTER_AUTH_MODE,
  MAGISTER_USER, MAGISTER_PASS, MAGISTER_STATE_DIR, MAGISTER_PERSIST_SESSION,
  MAGISTER_CHILD_ID, MAGISTER_SSO_ORIGINS, MAGISTER_SESSION_MAX_AGE_DAYS,
  MAGISTER_DEBUG
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
};

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  return String(pkg.version);
}

function storeFor(config: Config): AccountStore | null {
  return config.persistSession
    ? new AccountStore({
        stateDir: config.stateDir,
        schoolOrigin: config.schoolOrigin,
        profile: config.profile,
      })
    : null;
}

/** Loads config or reports CONFIG_INVALID (variable name only, never its value). */
function configOrExit(io: CliIo): Config | null {
  try {
    const config = loadConfig(io.env);
    setDebugLogging(config.debug);
    return config;
  } catch (error) {
    const publicError = toPublicError(error);
    logEvent('config_invalid', publicError.variable ? { variable: publicError.variable } : {});
    io.err(`${publicError.toPublicText()}\n`);
    return null;
  }
}

async function login(io: CliIo): Promise<number> {
  const config = configOrExit(io);
  if (!config) return 1;
  if (!config.persistSession) {
    io.err(`${new PublicError('CONFIG_INVALID', 'MAGISTER_PERSIST_SESSION').toPublicText()}\n`);
    return 1;
  }
  try {
    io.err('A browser window opens. Log in to Magister there; this waits up to 10 minutes.\n');
    await interactiveLogin(defaultClientDeps(config, storeFor(config)));
    io.out('Logged in. The session is stored locally for the MCP server.\n');
    return 0;
  } catch (error) {
    io.err(`${toPublicError(error).toPublicText()}\n`);
    return 1;
  }
}

async function logout(io: CliIo): Promise<number> {
  const config = configOrExit(io);
  if (!config) return 1;
  const store = storeFor(config);
  try {
    const removed = store ? await store.deleteAccount() : false;
    io.out(
      `${removed ? 'Local session removed' : 'No local session found'} ` +
        '(local logout; server-side tokens are not revoked).\n'
    );
    return 0;
  } catch (error) {
    io.err(`${toPublicError(error).toPublicText()}\n`);
    return 1;
  }
}

/** Starts the stdio server. Resolves once connected; shutdown exits the process. */
async function serve(io: CliIo): Promise<number | null> {
  const config = configOrExit(io);
  if (!config) return 1;
  if (LEGACY_FILES.some((name) => existsSync(join(PACKAGE_ROOT, name)))) {
    logEvent('legacy_state_present', {}, 'warn');
  }

  let client: MagisterClient | null = null;
  const server = createServer({
    version: packageVersion(),
    clientFactory: () => {
      client = new MagisterClient(defaultClientDeps(config, storeFor(config)));
      return client;
    },
  });

  let stopping: Promise<void> | null = null;
  const shutdown = (reason: SafeTag) => {
    stopping ??= (async () => {
      logEvent('shutdown', { reason });
      try {
        await client?.close();
        await server.close();
      } catch {
        logEvent('browser_close_failed', {}, 'warn');
      }
      logEvent('server_stopped');
      process.exit(0);
    })();
    return stopping;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.once('end', () => void shutdown('stdin'));
  process.stdin.once('close', () => void shutdown('stdin'));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('transport');
  await server.connect(transport);
  logEvent('server_started');
  return null;
}

/**
 * Entry point. Returns an exit code, or null while the server keeps running.
 */
export async function run(argv: string[], io: CliIo = defaultIo): Promise<number | null> {
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  switch (command) {
    case undefined:
      return serve(io);
    case 'login':
      return login(io);
    case 'logout':
      return logout(io);
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case '--version':
      io.out(`${packageVersion()}\n`);
      return 0;
    default:
      io.err(USAGE);
      return 2;
  }
}
