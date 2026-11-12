import { z } from 'zod';
import type { BrowserSession } from './browser-session.js';
import { PublicError } from './errors.js';
import { logEvent, SafeTag } from './logger.js';

/**
 * The Magister REST API boundary.
 *
 * Requests go to an absolute URL on the exact school origin, carry the bearer
 * token, never follow redirects and are validated against a schema. 401 maps
 * to SESSION_EXPIRED, a schema mismatch to UPSTREAM_INVALID_RESPONSE and
 * everything else (3xx, 5xx, network, timeout) to UPSTREAM_UNAVAILABLE.
 */

const MAX_BODY_CHARS = 5 * 1024 * 1024;
/** More appointments than this in one response is treated as an invalid response. */
export const MAX_APPOINTMENTS = 2000;

export const AccountSchema = z.object({
  Persoon: z.object({ Id: z.number().int().positive() }),
});

const ChildSchema = z
  .object({
    Id: z.number().int().positive().optional(),
    LeerlingId: z.number().int().positive().optional(),
    Persoon: z.object({ Id: z.number().int().positive() }).optional(),
  })
  .transform((child) => child.Id ?? child.Persoon?.Id ?? child.LeerlingId)
  .refine((id): id is number => id !== undefined);

export const ChildrenSchema = z
  .union([z.object({ Items: z.array(ChildSchema) }), z.array(ChildSchema)])
  .transform((value) => (Array.isArray(value) ? value : value.Items));

const NamedSchema = z.object({ Naam: z.string().nullish() });
const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

export const AppointmentSchema = z.object({
  Start: Timestamp,
  Einde: Timestamp,
  Omschrijving: z.string().nullish(),
  Vakken: z.array(NamedSchema).nullish(),
  Docenten: z.array(NamedSchema).nullish(),
  Lokalen: z.array(NamedSchema).nullish(),
  Lokatie: z.string().nullish(),
  Status: z.number().nullish(),
  Uitval: z.boolean().nullish(),
  Vervallen: z.boolean().nullish(),
  Inhoud: z.string().nullish(),
  Id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  /** AfspraakInfoType: 1 homework, 2-5 tests, 0/6/7 other. */
  InfoType: z.number().int().nonnegative().nullish(),
  Afgerond: z.boolean().nullish(),
});

export type Appointment = z.infer<typeof AppointmentSchema>;

const AppointmentList = z.array(AppointmentSchema).max(MAX_APPOINTMENTS);

/**
 * A list envelope must contain everything it advertises: a TotalCount above
 * the returned items would mean a silently incomplete result. `Links` (paging)
 * is never read or followed.
 */
export const AppointmentsSchema = z
  .union([
    z
      .object({ Items: AppointmentList, TotalCount: z.number().int().nonnegative().optional() })
      .refine((value) => value.TotalCount === undefined || value.TotalCount <= value.Items.length),
    AppointmentList,
  ])
  .transform((value) => (Array.isArray(value) ? value : value.Items));

export function isCancelled(appt: Appointment): boolean {
  return appt.Status === 5 || appt.Uitval === true || appt.Vervallen === true;
}

export type ApiEndpoint = Extract<SafeTag, 'account' | 'children' | 'schedule'>;

interface RawResponse {
  status: number;
  text?: string;
}

export class MagisterApi {
  constructor(
    private readonly session: BrowserSession,
    private readonly schoolOrigin: string,
    private readonly timeoutMs: number
  ) {}

  async get<T extends z.ZodType>(
    endpoint: ApiEndpoint,
    path: string,
    schema: T,
    token: string
  ): Promise<z.output<T>> {
    const result = await this.request(endpoint, path, schema, token, false);
    if (result === null) throw new PublicError('UPSTREAM_UNAVAILABLE');
    return result;
  }

  /** Like get(), but answers null on 403/404 (endpoint not available for this account). */
  getOptional<T extends z.ZodType>(
    endpoint: ApiEndpoint,
    path: string,
    schema: T,
    token: string
  ): Promise<z.output<T> | null> {
    return this.request(endpoint, path, schema, token, true);
  }

  private async request<T extends z.ZodType>(
    endpoint: ApiEndpoint,
    path: string,
    schema: T,
    token: string,
    allowMissing: boolean
  ): Promise<z.output<T> | null> {
    if (!path.startsWith('/api/')) throw new PublicError('INTERNAL');
    const url = `${this.schoolOrigin}${path}`;
    await this.session.ensureSchoolDocument();

    let raw: RawResponse;
    try {
      raw = await this.session.guard.race(
        this.session.page.evaluate(
          async ({ url, token, timeoutMs, maxChars }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const response = await fetch(url, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
                redirect: 'manual',
                signal: controller.signal,
              });
              if (response.type === 'opaqueredirect') return { status: 302 };
              if (response.status !== 200) return { status: response.status };
              const text = await response.text();
              return text.length > maxChars ? { status: 0 } : { status: 200, text };
            } catch {
              return { status: 0 };
            } finally {
              clearTimeout(timer);
            }
          },
          { url, token, timeoutMs: this.timeoutMs, maxChars: MAX_BODY_CHARS }
        )
      );
    } catch (error) {
      if (error instanceof PublicError) throw error;
      raw = { status: 0 };
    }
    this.session.guard.assertTrusted();

    if (raw.status === 401) throw new PublicError('SESSION_EXPIRED');
    if (allowMissing && (raw.status === 403 || raw.status === 404)) return null;
    if (raw.status !== 200 || raw.text === undefined) {
      logEvent('api_error', { endpoint, status: raw.status }, 'warn');
      throw new PublicError('UPSTREAM_UNAVAILABLE');
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.text);
    } catch {
      logEvent('api_error', { endpoint, status: raw.status, invalid: true }, 'warn');
      throw new PublicError('UPSTREAM_INVALID_RESPONSE');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      logEvent('api_error', { endpoint, status: raw.status, invalid: true }, 'warn');
      throw new PublicError('UPSTREAM_INVALID_RESPONSE');
    }
    return parsed.data;
  }
}
