import { chromium, Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { cacheKey, ScheduleCache } from './cache.js';
import { Config } from './config.js';
import { CalendarDate } from './dates.js';
import { PublicError } from './errors.js';
import { logEvent } from './logger.js';
import { ClassResult, firstClass, lastClass, ScheduleItem } from './schedule.js';
import { ScheduleClient } from './server.js';
import { AccountStore, StoredSession } from './storage.js';

export class MagisterClient implements ScheduleClient {
  private readonly config: Config;
  private readonly store: AccountStore | null;
  private readonly cache = new ScheduleCache<ScheduleItem[]>();
  private personId: number | null = null;
  private sessionId: string = randomUUID();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private accessToken: string | null = null;
  private userId: number | null = null;

  constructor(config: Config, store: AccountStore | null) {
    this.config = config;
    this.store = store;
  }

  private getBaseUrl(): string {
    return this.config.schoolOrigin;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });

    // Try to restore the previous private session
    const stored = this.store ? await this.store.readSession() : null;
    const tooOld =
      stored !== null && Date.now() - Date.parse(stored.savedAt) > this.config.sessionMaxAgeMs;
    if (stored && !tooOld) {
      try {
        this.context = await this.browser.newContext({
          storageState: stored.storageState as BrowserContextOptions['storageState'],
        });
        this.page = await this.context.newPage();
        this.sessionId = stored.sessionId;
        this.personId = stored.accountPersonId;
        this.userId = stored.childId ?? stored.accountPersonId;
        this.accessToken = stored.accessToken;

        // Verify session is still valid by trying the API
        await this.page.goto(`${this.getBaseUrl()}/magister/`);
        await this.page.waitForTimeout(2000);

        // Quick check if we're logged in
        const url = this.page.url();
        if (!url.includes('accounts.magister.net') && this.userId) {
          return; // Session is valid, skip login
        }
      } catch {
        logEvent('session_expired', {}, 'warn');
      }
    }

    // Fresh login required
    if (this.context) await this.context.close();
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();

    await this.login();
  }

  private async login(): Promise<void> {
    if (!this.page || !this.config.username || !this.config.password) {
      throw new PublicError('NOT_LOGGED_IN');
    }

    await this.page.goto(this.getBaseUrl());

    // Wait for redirect to accounts.magister.net and username field
    await this.page.waitForSelector('#username', { timeout: 15000 });

    // Fill username
    await this.page.fill('#username', this.config.username);

    // Click "Doorgaan" button (DNA-BUTTON web component)
    // Use text-based selector since it's a custom element
    await this.page.click(
      'dna-button:has-text("Doorgaan"), button:has-text("Doorgaan"), [type="submit"]'
    );

    // Wait for password field to appear (step 2 of login)
    await this.page.waitForSelector('#password, input[type="password"]', { timeout: 15000 });

    // Fill password
    await this.page.fill('#password, input[type="password"]', this.config.password);

    // Handle any cookie consent or overlay dialogs
    try {
      // Common cookie consent buttons
      const consentSelectors = [
        'button:has-text("Accepteren")',
        'button:has-text("Accept")',
        'button:has-text("Akkoord")',
        'button:has-text("OK")',
        '[id*="cookie"] button',
        '[class*="cookie"] button',
        '[class*="consent"] button',
      ];
      for (const selector of consentSelectors) {
        const btn = await this.page.$(selector);
        if (btn && (await btn.isVisible())) {
          await btn.click();
          await this.page.waitForTimeout(500);
          break;
        }
      }
    } catch {
      // No consent dialog present.
    }

    // Set up listener to capture token from redirect URL before clicking
    const tokenHolder = { value: '' };
    this.page.on('framenavigated', (frame) => {
      const url = frame.url();
      if (
        url.includes('redirect_callback') ||
        url.includes('access_token') ||
        url.includes('id_token')
      ) {
        const tokenMatch = url.match(/access_token=([^&]+)/);
        if (tokenMatch) {
          tokenHolder.value = decodeURIComponent(tokenMatch[1]);
        }
        if (!tokenHolder.value) {
          const idMatch = url.match(/id_token=([^&]+)/);
          if (idMatch) {
            tokenHolder.value = decodeURIComponent(idMatch[1]);
          }
        }
      }
    });

    // Try multiple selectors for login button
    const loginSelectors = [
      'dna-button:has-text("Inloggen")',
      'button:has-text("Inloggen")',
      'dna-button[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
      '.btn-primary',
      '[data-testid="login"]',
    ];

    let clicked = false;
    for (const selector of loginSelectors) {
      try {
        const btn = await this.page.$(selector);
        if (btn) {
          const isVisible = await btn.isVisible();
          if (isVisible) {
            await btn.click({ timeout: 5000 });
            clicked = true;
            break;
          }
        }
      } catch {
        // Selector not clickable; try the next one.
      }
    }

    if (!clicked) {
      // Try pressing Enter as last resort
      await this.page.keyboard.press('Enter');
    }

    // Wait for navigation away from accounts.magister.net
    // Just wait for any URL on the school domain
    try {
      await this.page.waitForURL(
        (url) => {
          return url.origin === this.config.schoolOrigin;
        },
        { timeout: 30000 }
      );
    } catch {
      // Continue anyway - we might already be on the right page
    }

    await this.page.waitForTimeout(3000);

    // Use captured token
    if (tokenHolder.value) {
      this.accessToken = tokenHolder.value;
    } else {
      // Fallback: try to get token from page storage
      const token = await this.page.evaluate(() => {
        // Check various storage locations
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) {
            const val = sessionStorage.getItem(key);
            if (val && val.startsWith('eyJ') && val.length > 100) {
              return val;
            }
          }
        }
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            const val = localStorage.getItem(key);
            if (val && val.startsWith('eyJ') && val.length > 100) {
              return val;
            }
          }
        }
        return null;
      });
      if (token) {
        this.accessToken = token;
      }
    }

    // Make sure we're on the school domain before API calls
    const currentUrl = this.page.url();

    if (new URL(currentUrl).origin !== this.config.schoolOrigin) {
      await this.page.goto(`${this.getBaseUrl()}/magister/`);
      await this.page.waitForTimeout(2000);
    }

    // Fetch user ID
    await this.fetchUserId();

    // Save auth state to disk for next time
    await this.saveAuthState();
  }

  private async saveAuthState(): Promise<void> {
    if (!this.context || !this.store || !this.config.persistSession) return;
    if (!this.personId || !this.accessToken) return;
    try {
      const storageState = await this.context.storageState();
      const session: StoredSession = {
        version: 1,
        schoolOrigin: this.config.schoolOrigin,
        profileHash: this.store.profileHash,
        accountPersonId: this.personId,
        childId: this.userId ?? undefined,
        sessionId: this.sessionId,
        savedAt: new Date().toISOString(),
        accessToken: this.accessToken,
        accessTokenExp: null,
        storageState: storageState as unknown as StoredSession['storageState'],
      };
      await this.store.writeSession(session);
      logEvent('session_saved');
    } catch {
      logEvent('session_save_skipped', {}, 'warn');
    }
  }

  private async fetchUserId(): Promise<void> {
    if (!this.page) return;

    try {
      const token = this.accessToken;
      const response = await this.page.evaluate(async (t) => {
        const headers: Record<string, string> = {
          Accept: 'application/json',
        };
        if (t) {
          headers['Authorization'] = `Bearer ${t}`;
        }

        const res = await fetch('/api/account', {
          credentials: 'include',
          headers,
        });
        if (!res.ok) return { error: res.status, statusText: res.statusText };
        return await res.json();
      }, token);

      // Check if this is a parent account with linked children
      if (response.Persoon?.Id) {
        const personId = response.Persoon.Id;
        this.personId = personId;

        // Try to get linked children (for parent accounts)
        const childrenResponse = await this.page.evaluate(
          async (params) => {
            const { personId, token } = params;
            const headers: Record<string, string> = {
              Accept: 'application/json',
            };
            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
            }

            // Try different endpoints for getting children
            const endpoints = [
              `/api/personen/${personId}/kinderen`,
              `/api/leerlingen`,
              `/api/accounts/${personId}/kinderen`,
            ];

            for (const endpoint of endpoints) {
              try {
                const res = await fetch(endpoint, { credentials: 'include', headers });
                if (res.ok) {
                  const data = await res.json();
                  return { endpoint, data };
                }
              } catch {
                // Continue to next endpoint
              }
            }
            return { error: 'No children endpoint found' };
          },
          { personId, token }
        );

        // Parse children response
        const children = childrenResponse.data?.Items || childrenResponse.data || [];
        if (Array.isArray(children) && children.length > 0) {
          // Use the first child's ID
          const child = children[0];
          this.userId = child.Id || child.Persoon?.Id || child.LeerlingId;
        } else {
          // No children found, use the logged-in person's ID (might be a student account)
          this.userId = personId;
        }
      }
    } catch {
      logEvent('api_error', { endpoint: 'account' }, 'warn');
    }
  }

  async getSchedule(dateStr: CalendarDate): Promise<ScheduleItem[]> {
    // Check cache first (SWR pattern)
    const cached = this.userId && this.personId ? this.cache.get(this.cacheKeyFor(dateStr)) : null;
    if (cached) {
      if (cached.fresh) {
        return cached.value;
      }
      // Return stale data immediately, but trigger refresh in background
      this.refreshScheduleInBackground(dateStr);
      return cached.value;
    }

    return this.fetchScheduleFromAPI(dateStr);
  }

  private refreshScheduleInBackground(dateStr: CalendarDate): void {
    // Don't await - let it run in background
    this.fetchScheduleFromAPI(dateStr).catch(() => {
      logEvent('cache_refresh_failed', {}, 'warn');
    });
  }

  private cacheKeyFor(date: CalendarDate): string {
    return cacheKey(this.personId ?? 0, this.userId ?? 0, date);
  }

  private async fetchScheduleFromAPI(dateStr: CalendarDate): Promise<ScheduleItem[]> {
    if (!this.page) throw new PublicError('INTERNAL');
    const generation = this.cache.generation;

    // Try to get userId if we don't have it
    if (!this.userId) {
      await this.fetchUserId();
      if (!this.userId) {
        throw new PublicError('UPSTREAM_UNAVAILABLE');
      }
    }

    // Make API call with cookies (and token if available)
    const apiResult = await this.page.evaluate(
      async (params) => {
        const { dateStr, userId, token } = params;

        try {
          const scheduleUrl = `/api/personen/${userId}/afspraken?status=1&van=${dateStr}&tot=${dateStr}`;

          const headers: Record<string, string> = {
            Accept: 'application/json',
          };
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          const res = await fetch(scheduleUrl, {
            credentials: 'include',
            headers,
          });

          if (!res.ok) {
            return { error: 'Failed to get schedule', status: res.status, url: scheduleUrl };
          }

          const schedule = await res.json();
          return { success: true, schedule };
        } catch (e) {
          return { error: String(e) };
        }
      },
      { dateStr, userId: this.userId, token: this.accessToken || '' }
    );

    if (apiResult.error) {
      logEvent('api_error', { endpoint: 'schedule' }, 'warn');
      return this.getScheduleFromDOM();
    }

    // Parse API response into ScheduleItems
    const items: ScheduleItem[] = [];
    const appointments = apiResult.schedule?.Items || apiResult.schedule || [];

    for (const appt of appointments) {
      items.push({
        startTime: appt.Start
          ? new Date(appt.Start).toLocaleTimeString('nl-NL', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Amsterdam',
            })
          : '',
        endTime: appt.Einde
          ? new Date(appt.Einde).toLocaleTimeString('nl-NL', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Amsterdam',
            })
          : '',
        subject: appt.Omschrijving || appt.Vakken?.[0]?.Naam || 'Unknown',
        teacher: appt.Docenten?.[0]?.Naam,
        location: appt.Lokalen?.[0]?.Naam || appt.Lokatie,
        cancelled: appt.Status === 5 || appt.Uitval || appt.Vervallen || false,
        description: appt.Inhoud,
      });
    }

    // Cache the result
    this.cache.set(this.cacheKeyFor(dateStr), items, generation);

    return items;
  }

  private async getScheduleFromDOM(): Promise<ScheduleItem[]> {
    if (!this.page) return [];

    // Navigate to agenda page
    await this.page.goto(`${this.getBaseUrl()}/magister/#/agenda`);
    await this.page.waitForTimeout(3000);

    // Extract schedule items from DOM
    const items = await this.page.evaluate(() => {
      const results: ScheduleItem[] = [];

      // Try various selectors
      const selectors = [
        '.agenda-item',
        '.appointment',
        '[class*="appointment"]',
        '[class*="agenda-list"] > *',
        '.rooster-item',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el) => {
            const text = el.textContent?.trim() || '';
            if (text.length > 0) {
              results.push({
                startTime: '',
                endTime: '',
                subject: text.slice(0, 100),
                cancelled: el.classList.contains('cancelled') || el.classList.contains('vervallen'),
                description: undefined,
              });
            }
          });
          break;
        }
      }

      return results;
    });

    return items;
  }

  async getWeekSchedule(dates: CalendarDate[]): Promise<Record<CalendarDate, ScheduleItem[]>> {
    const result: Record<CalendarDate, ScheduleItem[]> = {};
    for (const date of dates) {
      result[date] = await this.getSchedule(date);
    }
    return result;
  }

  async getFirstClass(date: CalendarDate): Promise<ClassResult> {
    return firstClass(await this.getSchedule(date));
  }

  async getLastClass(date: CalendarDate): Promise<ClassResult> {
    return lastClass(await this.getSchedule(date));
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
