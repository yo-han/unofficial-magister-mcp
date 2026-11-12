import type { EnvVarName, PublicErrorCode } from './errors.js';
import type { ToolName } from './tools.js';

/**
 * Structured, secret-safe logging to stderr. stdout is reserved for JSON-RPC.
 *
 * Only predefined events can be logged, and metadata values are limited to
 * numbers, booleans and fixed tags. There is deliberately no way to log a free
 * string, an exception or a URL.
 */
export type LogEvent =
  | 'server_started'
  | 'server_stopped'
  | 'config_invalid'
  | 'tool_called'
  | 'tool_failed'
  | 'browser_launched'
  | 'browser_closed'
  | 'browser_close_failed'
  | 'session_restored'
  | 'session_missing'
  | 'session_expired'
  | 'session_saved'
  | 'session_save_skipped'
  | 'session_refreshed'
  | 'session_removed'
  | 'legacy_state_present'
  | 'login_started'
  | 'login_completed'
  | 'login_failed'
  | 'origin_blocked'
  | 'api_error'
  | 'cache_hit'
  | 'cache_refresh_failed'
  | 'shutdown';

export type SafeTag =
  | ToolName
  | PublicErrorCode
  | EnvVarName
  | 'interactive'
  | 'password'
  | 'account'
  | 'children'
  | 'schedule'
  | 'navigation'
  | 'redirect'
  | 'popup'
  | 'credentials'
  | 'max_age'
  | 'SIGINT'
  | 'SIGTERM'
  | 'stdin'
  | 'transport';

export type SafeMeta = Readonly<Record<string, number | boolean | SafeTag>>;
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stderr.write(line);
};

let sink: LogSink = defaultSink;
let debugEnabled = false;

/** Replace the output sink (tests). Pass undefined to restore stderr. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? defaultSink;
}

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export function logEvent(event: LogEvent, meta: SafeMeta = {}, level: LogLevel = 'info'): void {
  if (level === 'debug' && !debugEnabled) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta });
  sink(`${line}\n`);
}
