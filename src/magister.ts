import { chromium } from 'playwright';
import {
  AcquiredToken,
  buildSession,
  captureStorageState,
  fetchAccountId,
  Identity,
  passwordLogin,
  refreshToken,
  resolveChild,
} from './auth.js';
import { AssignmentItem, toHomework, toTests } from './assignments.js';
import { BrowserSession, ClientDeps, DEFAULT_TIMEOUTS } from './browser-session.js';
import { cacheKey, ScheduleCache } from './cache.js';
import type { Config } from './config.js';
import { amsterdamDateOf, CalendarDate, formatAmsterdamTime } from './dates.js';
import { PublicError } from './errors.js';
import { logEvent } from './logger.js';
import { Appointment, AppointmentsSchema, isCancelled } from './magister-api.js';
import { ClassResult, firstClass, lastClass, ScheduleItem } from './schedule.js';
import type { ScheduleClient } from './server.js';
import type { AccountStore, StoredSession } from './storage.js';

export type { ClientDeps, ClientTimeouts } from './browser-session.js';

/** Refresh a token this long before its `exp`. */
const EXPIRY_MARGIN_MS = 60_000;

export function defaultClientDeps(config: Config, store: AccountStore | null): ClientDeps {
  return {
    config,
    store,
    launchBrowser: (headless) => chromium.launch({ headless }),
    timeouts: DEFAULT_TIMEOUTS,
  };
}

interface ActiveSession extends Identity {
  browser: BrowserSession;
  token: AcquiredToken;
  /** Matches session.json; null when persistence is disabled. */
  sessionId: string | null;
  /** The stored session this one was built from, for refresh saves. */
  stored: StoredSession | null;
}

export function toScheduleItem(appt: Appointment): ScheduleItem {
  return {
    startTime: formatAmsterdamTime(appt.Start),
    endTime: formatAmsterdamTime(appt.Einde),
    subject: appt.Omschrijving || appt.Vakken?.[0]?.Naam || 'Unknown',
    teacher: appt.Docenten?.[0]?.Naam ?? undefined,
    location: appt.Lokalen?.[0]?.Naam || appt.Lokatie || undefined,
    cancelled: isCancelled(appt),
    description: appt.Inhoud ?? undefined,
  };
}

/**
 * Reads schedules for one Magister account.
 *
 * Nothing is started until the first call. Without a stored session the call
 * fails with NOT_LOGGED_IN before a browser exists (except in password mode).
 * A restored session is checked against /api/account; its token is refreshed
 * silently at most once per failure. Before every call the client checks that
 * session.json still holds the same session, so a `logout` from another
 * process takes effect on the next call.
 */
export class MagisterClient implements ScheduleClient {
  private readonly deps: ClientDeps;
  private readonly cache = new ScheduleCache<Appointment[]>();
  private ready: Promise<ActiveSession> | null = null;
  private active: ActiveSession | null = null;
  private refreshing: Promise<void> | null = null;
  private closed = false;

  constructor(deps: ClientDeps) {
    this.deps = deps;
  }

  private get config(): Config {
    return this.deps.config;
  }

  /** One shared initialisation; reset (and the browser closed) when it fails. */
  private ensureReady(): Promise<ActiveSession> {
    if (this.closed) return Promise.reject(new PublicError('INTERNAL'));
    this.ready ??= this.initialize().then(
      (active) => {
        this.active = active;
        return active;
      },
      async (error) => {
        this.ready = null;
        throw error;
      }
    );
    return this.ready;
  }

  private async initialize(): Promise<ActiveSession> {
    const store = this.deps.store;
    const stored = store ? await store.readSession() : null;
    if (stored === null) {
      logEvent('session_missing');
      if (this.config.authMode === 'password') return this.loginWithPassword();
      throw new PublicError('NOT_LOGGED_IN');
    }
    if (Date.now() - Date.parse(stored.savedAt) > this.config.sessionMaxAgeMs) {
      logEvent('session_expired', { reason: 'max_age' }, 'warn');
      if (this.config.authMode === 'password') return this.loginWithPassword();
      throw new PublicError('SESSION_EXPIRED');
    }
    return this.restore(stored);
  }

  private async withBrowser<T>(browser: BrowserSession, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  private async loginWithPassword(): Promise<ActiveSession> {
    const browser = await BrowserSession.open(this.deps, true);
    return this.withBrowser(browser, async () => {
      const token = await passwordLogin(browser, this.deps);
      const accountPersonId = await fetchAccountId(browser, token.accessToken);
      const childId = await resolveChild(browser, this.config, token.accessToken, accountPersonId);
      let stored: StoredSession | null = null;
      if (this.deps.store) {
        stored = buildSession(
          this.deps,
          { accountPersonId, childId },
          token,
          await captureStorageState(browser)
        );
        browser.guard.assertTrusted();
        await this.deps.store.writeSession(stored);
        logEvent('session_saved');
      }
      return {
        browser,
        token,
        accountPersonId,
        childId,
        sessionId: stored?.sessionId ?? null,
        stored,
      };
    });
  }

  private async restore(stored: StoredSession): Promise<ActiveSession> {
    const browser = await BrowserSession.open(this.deps, true, stored.storageState);
    return this.withBrowser(browser, async () => {
      const active: ActiveSession = {
        browser,
        token: { accessToken: stored.accessToken, accessTokenExp: stored.accessTokenExp },
        accountPersonId: stored.accountPersonId,
        childId: stored.childId,
        sessionId: stored.sessionId,
        stored,
      };
      if (isExpired(active.token)) await this.refresh(active);

      let accountPersonId: number;
      try {
        accountPersonId = await fetchAccountId(browser, active.token.accessToken);
      } catch (error) {
        if (!(error instanceof PublicError) || error.code !== 'SESSION_EXPIRED') throw error;
        await this.refresh(active);
        accountPersonId = await fetchAccountId(browser, active.token.accessToken);
      }
      if (accountPersonId !== stored.accountPersonId) throw new PublicError('SESSION_MISMATCH');

      if (this.config.childId !== undefined && this.config.childId !== stored.childId) {
        active.childId = await resolveChild(
          browser,
          this.config,
          active.token.accessToken,
          accountPersonId
        );
      }
      logEvent('session_restored');
      return active;
    });
  }

  /** Gets a new token and saves it, unless the session was logged out meanwhile. */
  private async refresh(active: ActiveSession): Promise<void> {
    const token = await refreshToken(active.browser, this.deps);
    active.browser.guard.assertTrusted();
    const accountPersonId = await fetchAccountId(active.browser, token.accessToken);
    if (accountPersonId !== active.accountPersonId) throw new PublicError('SESSION_MISMATCH');
    if (this.deps.store && active.stored && active.sessionId) {
      const updated: StoredSession = {
        ...active.stored,
        accessToken: token.accessToken,
        accessTokenExp: token.accessTokenExp,
        storageState: await captureStorageState(active.browser),
      };
      if (!(await this.deps.store.replaceSession(updated, active.sessionId))) {
        throw new PublicError('NOT_LOGGED_IN');
      }
      active.stored = updated;
    }
    active.token = token;
  }

  private refreshShared(active: ActiveSession): Promise<void> {
    this.refreshing ??= this.refresh(active).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Closes the browser and forgets everything; the next call starts over. */
  private async reset(): Promise<void> {
    const active = this.active;
    this.active = null;
    this.ready = null;
    this.cache.clear();
    if (active) await active.browser.close();
  }

  /** A ready session that still matches session.json. */
  private async session(): Promise<ActiveSession> {
    const active = await this.ensureReady();
    if (this.deps.store && active.sessionId !== null) {
      let current: string | null;
      try {
        current = await this.deps.store.currentSessionId();
      } catch (error) {
        await this.reset();
        throw error;
      }
      if (current !== active.sessionId) {
        logEvent('session_removed', {}, 'warn');
        await this.reset();
        throw new PublicError('NOT_LOGGED_IN');
      }
    }
    if (active.browser.guard.broken) {
      await this.reset();
      throw new PublicError('ORIGIN_VIOLATION');
    }
    return active;
  }

  /** Runs an API call, refreshing the token once on expiry or a 401. */
  private async withToken<T>(
    active: ActiveSession,
    call: (token: string) => Promise<T>
  ): Promise<T> {
    if (isExpired(active.token)) await this.refreshShared(active);
    try {
      return await call(active.token.accessToken);
    } catch (error) {
      if (!(error instanceof PublicError) || error.code !== 'SESSION_EXPIRED') throw error;
      await this.refreshShared(active);
      return call(active.token.accessToken);
    }
  }

  private personFor(active: ActiveSession): number {
    return active.childId ?? active.accountPersonId;
  }

  private keyFor(active: ActiveSession, date: CalendarDate): string {
    return cacheKey(active.accountPersonId, this.personFor(active), date);
  }

  /** Fetches [from, to] in one call and caches the validated appointments of every date. */
  private async fetchAppointments(
    active: ActiveSession,
    dates: CalendarDate[]
  ): Promise<Record<CalendarDate, Appointment[]>> {
    const generation = this.cache.generation;
    const from = dates[0];
    const to = dates[dates.length - 1];
    const person = this.personFor(active);
    const path = `/api/personen/${person}/afspraken?status=1&van=${from}&tot=${to}`;
    const appointments = await this.withToken(active, (token) =>
      active.browser.api.get('schedule', path, AppointmentsSchema, token)
    );

    const byDate: Record<CalendarDate, Appointment[]> = {};
    for (const date of dates) byDate[date] = [];
    for (const appt of appointments) {
      byDate[amsterdamDateOf(appt.Start)]?.push(appt);
    }
    for (const date of dates) this.cache.set(this.keyFor(active, date), byDate[date], generation);
    return byDate;
  }

  private refreshInBackground(active: ActiveSession, dates: CalendarDate[]): void {
    this.fetchAppointments(active, dates).catch(() => logEvent('cache_refresh_failed', {}, 'warn'));
  }

  /** Appointments for consecutive dates, with one API call when anything is missing. */
  private async appointmentsFor(
    dates: CalendarDate[]
  ): Promise<Record<CalendarDate, Appointment[]>> {
    if (dates.length === 0) return {};
    const active = await this.session();
    const hits = dates.map((date) => this.cache.get(this.keyFor(active, date)));
    if (hits.every((hit) => hit !== null)) {
      logEvent('cache_hit', { days: dates.length });
      if (hits.some((hit) => !hit?.fresh)) this.refreshInBackground(active, dates);
      return Object.fromEntries(dates.map((date, index) => [date, hits[index]!.value]));
    }
    return this.fetchAppointments(active, dates);
  }

  async getSchedule(date: CalendarDate): Promise<ScheduleItem[]> {
    return (await this.getWeekSchedule([date]))[date];
  }

  /** Schedules for consecutive dates, with one API call when anything is missing. */
  async getWeekSchedule(dates: CalendarDate[]): Promise<Record<CalendarDate, ScheduleItem[]>> {
    const byDate = await this.appointmentsFor(dates);
    return Object.fromEntries(dates.map((date) => [date, byDate[date].map(toScheduleItem)]));
  }

  /** Homework on consecutive dates, in chronological order. */
  async getHomework(dates: CalendarDate[]): Promise<AssignmentItem[]> {
    const byDate = await this.appointmentsFor(dates);
    return toHomework(dates.flatMap((date) => byDate[date]));
  }

  /** Tests on consecutive dates, in chronological order. */
  async getTests(dates: CalendarDate[]): Promise<AssignmentItem[]> {
    const byDate = await this.appointmentsFor(dates);
    return toTests(dates.flatMap((date) => byDate[date]));
  }

  async getFirstClass(date: CalendarDate): Promise<ClassResult> {
    return firstClass(await this.getSchedule(date));
  }

  async getLastClass(date: CalendarDate): Promise<ClassResult> {
    return lastClass(await this.getSchedule(date));
  }

  /** Idempotent; waits for a pending start so no browser is left behind. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = this.ready;
    if (pending) await pending.catch(() => undefined);
    await this.reset();
  }
}

function isExpired(token: AcquiredToken): boolean {
  return (
    token.accessTokenExp !== null && token.accessTokenExp * 1000 - EXPIRY_MARGIN_MS <= Date.now()
  );
}
