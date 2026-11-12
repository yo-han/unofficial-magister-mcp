/** The only origin where Magister credentials may ever be entered automatically. */
export const AUTH_ORIGIN = 'https://accounts.magister.net';

export interface OriginPolicy {
  readonly schoolOrigin: string;
  /** May a top-level navigation go to this URL? */
  isNavigationAllowed(url: string): boolean;
  /** Is this URL on exactly the configured school origin? */
  isSchoolOrigin(url: string): boolean;
  /** May credentials be filled on this URL? Only the Magister auth origin, never SSO. */
  isCredentialOrigin(url: string): boolean;
}

/**
 * Returns the origin of a URL, or null if it cannot be trusted as one
 * (unparseable, opaque origin, or carrying userinfo).
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

export function createOriginPolicy(options: {
  schoolOrigin: string;
  ssoOrigins: readonly string[];
}): OriginPolicy {
  const allowed = new Set([options.schoolOrigin, AUTH_ORIGIN, ...options.ssoOrigins]);
  return {
    schoolOrigin: options.schoolOrigin,
    isNavigationAllowed(url) {
      if (url === 'about:blank') return true;
      const origin = originOf(url);
      return origin !== null && allowed.has(origin);
    },
    isSchoolOrigin(url) {
      return originOf(url) === options.schoolOrigin;
    },
    isCredentialOrigin(url) {
      return originOf(url) === AUTH_ORIGIN;
    },
  };
}
