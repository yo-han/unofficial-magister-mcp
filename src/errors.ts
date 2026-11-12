/**
 * Errors that may cross a trust boundary (MCP client, stderr, CLI output).
 *
 * The message of a PublicError is always a fixed text chosen by its code, never
 * built from input, upstream responses or other exceptions.
 */

export const PUBLIC_ERROR_MESSAGES = {
  CONFIG_INVALID: 'The server configuration is invalid.',
  INVALID_ARGUMENT:
    'Invalid argument. Use "today", "tomorrow", a weekday name or a YYYY-MM-DD date. Ranges are inclusive, from must not be after to, at most 31 days.',
  UNKNOWN_TOOL: 'Unknown tool.',
  NOT_LOGGED_IN: 'Not logged in to Magister. Run `unofficial-magister-mcp login` first.',
  SESSION_EXPIRED:
    'The Magister session has expired. Run `unofficial-magister-mcp login` to sign in again.',
  SESSION_MISMATCH:
    'The saved Magister session belongs to a different account. Run `unofficial-magister-mcp logout` and log in again.',
  LOGIN_FAILED: 'The Magister login did not complete.',
  MFA_REQUIRED:
    'Magister requires a verification code. Configure MAGISTER_1PASSWORD_OTP for automatic verification.',
  MFA_UNAVAILABLE:
    '1Password could not provide a verification code. Unlock 1Password and allow CLI access, then retry.',
  ORIGIN_VIOLATION:
    'Stopped authentication because a browser request targeted an origin that is not allowed.',
  STORAGE_UNSAFE:
    'The session storage location failed its privacy checks (owner, type or symlink).',
  UPSTREAM_UNAVAILABLE: 'Magister could not be reached or returned an error. Try again later.',
  UPSTREAM_INVALID_RESPONSE: 'Magister returned a response in an unexpected format.',
  CHILD_NOT_FOUND: 'The configured MAGISTER_CHILD_ID is not linked to this account.',
  INTERNAL: 'An internal error occurred.',
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

/** Names of configuration variables; safe to show because they are never user data. */
export type EnvVarName =
  | 'MAGISTER_SCHOOL'
  | 'MAGISTER_PROFILE'
  | 'MAGISTER_AUTH_MODE'
  | 'MAGISTER_USER'
  | 'MAGISTER_PASS'
  | 'MAGISTER_1PASSWORD_OTP'
  | 'MAGISTER_1PASSWORD_COMMAND'
  | 'MAGISTER_1PASSWORD_ACCOUNT'
  | 'MAGISTER_STATE_DIR'
  | 'MAGISTER_PERSIST_SESSION'
  | 'MAGISTER_CHILD_ID'
  | 'MAGISTER_SSO_ORIGINS'
  | 'MAGISTER_SESSION_MAX_AGE_DAYS';

export class PublicError extends Error {
  readonly code: PublicErrorCode;
  /** Set for CONFIG_INVALID: which variable is wrong (never its value). */
  readonly variable: EnvVarName | undefined;

  constructor(code: PublicErrorCode, variable?: EnvVarName) {
    super(PUBLIC_ERROR_MESSAGES[code]);
    this.name = 'PublicError';
    this.code = code;
    this.variable = variable;
  }

  /** The exact text that may be shown to a client or user. */
  toPublicText(): string {
    const suffix = this.variable ? ` (${this.variable})` : '';
    return `[${this.code}] ${this.message}${suffix}`;
  }
}

/**
 * Maps any thrown value to something safe to show. A PublicError passes
 * through; everything else becomes INTERNAL without keeping the original
 * message or cause.
 */
export function toPublicError(error: unknown): PublicError {
  return error instanceof PublicError ? error : new PublicError('INTERNAL');
}
