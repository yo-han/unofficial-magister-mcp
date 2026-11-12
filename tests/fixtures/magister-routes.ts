/**
 * Route-controlled synthetic Magister school and auth server for Chromium.
 *
 * Every request in the context is answered here or aborted, so nothing leaves
 * the machine. All people, ids and lessons are synthetic. Redirects use
 * scripted navigations instead of HTTP 3xx because Playwright does not route
 * redirect hops (a fulfilled 302 to an unrouted host would hit the network).
 */
import type { BrowserContext, Route } from 'playwright';

export const FIXTURE_SCHOOL = 'https://fixture-school.magister.net';
export const AUTH = 'https://accounts.magister.net';
export const CALLBACK_PATH = '/oidc/redirect_callback.html';
export const PARENT_ID = 1001;
export const CHILD_A = 2001;
export const CHILD_B = 2002;
export const TEST_USERNAME = 'synthetic-parent';
export const TEST_PASSWORD = 'synthetic-password-not-real';

export type LoginBehaviour = 'auto' | 'manual';

export interface FixtureOptions {
  accountPersonId: number;
  children: number[];
  /** auto: the login page fills and submits itself, simulating the user. */
  loginBehaviour: LoginBehaviour;
  /** Origin that hosts the login form (default: the Magister auth origin). */
  loginOrigin: string;
  /** Where the callback page navigates after storing the token. */
  afterCallback: string;
  /** Put only an id_token in the callback fragment. */
  idTokenOnly: boolean;
  /** Open a popup from the login page. */
  popupFromLogin: string | null;
  /** Force /api/account to answer with this status. */
  accountStatus: number | null;
  /** Answer GET /magister/ with an HTTP 302 to this location (an unrouted hop). */
  appRedirect: string | null;
  /** Answer the schedule endpoint with a 302 to this location. */
  scheduleRedirect: string | null;
  /** Answer the schedule endpoint with a body that does not match the schema. */
  scheduleInvalid: boolean;
  /** Delay before the authorize endpoint redirects back with tokens. */
  authorizeDelayMs: number;
  /** Lifetime of issued access tokens in seconds (negative = already expired). */
  tokenLifetimeSec: number;
  /** Synthetic appointments per person id and Amsterdam date. */
  appointments: Map<number, Map<string, Appointment[]>>;
}

export interface Appointment {
  Start: string;
  Einde: string;
  Omschrijving?: string | null;
  Vakken?: { Naam: string }[];
  Docenten?: { Naam: string; Docentcode?: string }[];
  Lokalen?: { Naam: string }[];
  Lokatie?: string | null;
  Status?: number;
  Inhoud?: string | null;
  [key: string]: unknown;
}

export interface FixtureState {
  options: FixtureOptions;
  /** Valid SSO session cookie values. */
  ssoSessions: Set<string>;
  /** Valid access tokens. */
  issuedTokens: Set<string>;
  /** Every URL the browser requested. */
  requests: string[];
  /** Requests to origins outside the fixture (all aborted). */
  external: string[];
  /** Credentials received by any login endpoint. */
  loginPosts: { origin: string; username: string; password: string }[];
  /** Schedule requests as `${personId} ${van} ${tot}`. */
  scheduleCalls: string[];
  authorizeCalls: number;
}

export function createFixtureState(overrides: Partial<FixtureOptions> = {}): FixtureState {
  return {
    options: {
      accountPersonId: PARENT_ID,
      children: [CHILD_A, CHILD_B],
      loginBehaviour: 'auto',
      loginOrigin: AUTH,
      afterCallback: `${FIXTURE_SCHOOL}/magister/#/vandaag`,
      idTokenOnly: false,
      popupFromLogin: null,
      accountStatus: null,
      appRedirect: null,
      scheduleRedirect: null,
      scheduleInvalid: false,
      authorizeDelayMs: 0,
      tokenLifetimeSec: 3600,
      appointments: new Map(),
      ...overrides,
    },
    ssoSessions: new Set(),
    issuedTokens: new Set(),
    requests: [],
    external: [],
    loginPosts: [],
    scheduleCalls: [],
    authorizeCalls: 0,
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

let tokenCounter = 0;
export function issueToken(state: FixtureState): string {
  tokenCounter += 1;
  const exp = Math.floor(Date.now() / 1000) + state.options.tokenLifetimeSec;
  const token = [
    base64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64url(JSON.stringify({ sub: 'synthetic', exp, n: tokenCounter })),
    'sig',
  ].join('.');
  state.issuedTokens.add(token);
  return token;
}

const offsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Amsterdam',
  timeZoneName: 'longOffset',
});

/** ISO timestamp with the Amsterdam offset for a local date and HH:MM time. */
export function amsterdamIso(date: string, time: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  const zone = offsetFormat.formatToParts(noon).find((p) => p.type === 'timeZoneName')?.value;
  const offset = zone === 'GMT' ? '+00:00' : (zone ?? 'GMT+01:00').replace('GMT', '');
  return `${date}T${time}:00.0000000${offset}`;
}

export function lesson(
  date: string,
  start: string,
  end: string,
  subject: string,
  extra: Partial<Appointment> = {}
): Appointment {
  return {
    Start: amsterdamIso(date, start),
    Einde: amsterdamIso(date, end),
    Omschrijving: `${subject.toLowerCase().slice(0, 3)} - 1a`,
    Vakken: [{ Naam: subject }],
    Docenten: [{ Naam: 'T. Synthetic', Docentcode: 'TSY' }],
    Lokalen: [{ Naam: 'B1.01' }],
    Lokatie: null,
    Status: 1,
    Inhoud: null,
    Id: Math.floor(Math.random() * 1e6),
    ...extra,
  };
}

export function allDayNotice(date: string, nextDate: string, text: string): Appointment {
  return {
    Start: amsterdamIso(date, '00:00'),
    Einde: amsterdamIso(nextDate, '00:00'),
    Omschrijving: text,
    Vakken: [],
    Docenten: [],
    Lokalen: [],
    Status: 1,
    Inhoud: text,
  };
}

export function setAppointments(
  state: FixtureState,
  personId: number,
  date: string,
  items: Appointment[]
) {
  const perPerson = state.options.appointments.get(personId) ?? new Map();
  perPerson.set(date, items);
  state.options.appointments.set(personId, perPerson);
}

function html(route: Route, body: string, headers: Record<string, string> = {}) {
  return route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers,
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
  });
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function authorizeUrl(): string {
  const redirect = encodeURIComponent(`${FIXTURE_SCHOOL}${CALLBACK_PATH}`);
  return `${AUTH}/connect/authorize?client_id=M6-fixture-school.magister.net&redirect_uri=${redirect}&response_type=id_token%20token`;
}

function loginPage(state: FixtureState, origin: string): string {
  const { loginBehaviour, popupFromLogin } = state.options;
  const auto =
    loginBehaviour === 'auto'
      ? `setTimeout(() => {
           document.getElementById('username').value = ${JSON.stringify(TEST_USERNAME)};
           document.getElementById('next').click();
           document.getElementById('password').value = ${JSON.stringify(TEST_PASSWORD)};
           document.getElementById('login').click();
         }, 50);`
      : '';
  const popup = popupFromLogin ? `window.open(${JSON.stringify(popupFromLogin)});` : '';
  return `
    <form onsubmit="return false">
      <input id="username" name="username">
      <button id="next" type="button">Doorgaan</button>
      <div id="step2" hidden>
        <input id="password" type="password" name="password">
        <button id="login" type="button">Inloggen</button>
      </div>
      <p id="error" hidden>Onjuiste gegevens</p>
    </form>
    <script>
      document.getElementById('next').onclick = () => {
        document.getElementById('step2').hidden = false;
      };
      document.getElementById('login').onclick = async () => {
        const res = await fetch(${JSON.stringify(`${origin}/account/login`)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) location.replace(${JSON.stringify(authorizeUrl())});
        else document.getElementById('error').hidden = false;
      };
      ${popup}
      ${auto}
    </script>`;
}

const SCHOOL_APP = `
  <h1>Synthetic Magister</h1>
  <script>
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('oidc.user:'));
    if (!key) location.replace(${JSON.stringify(authorizeUrl())});
  </script>`;

const CALLBACK_PAGE = (after: string) => `
  <script>
    const params = new URLSearchParams(location.hash.slice(1));
    const user = { access_token: params.get('access_token'), id_token: params.get('id_token') };
    if (user.access_token) {
      sessionStorage.setItem(
        'oidc.user:https://accounts.magister.net:M6-fixture-school.magister.net',
        JSON.stringify(user)
      );
    }
    setTimeout(() => location.replace(${JSON.stringify(after)}), 100);
  </script>`;

async function handleSchool(route: Route, url: URL, state: FixtureState) {
  const { options } = state;
  if (url.pathname === '/magister/' && options.appRedirect) {
    return route.fulfill({ status: 302, headers: { location: options.appRedirect } });
  }
  if (url.pathname === '/' || url.pathname === '/magister/') return html(route, SCHOOL_APP);
  if (url.pathname === CALLBACK_PATH) return html(route, CALLBACK_PAGE(options.afterCallback));
  if (url.pathname === '/robots.txt') {
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'User-agent: *\n' });
  }
  if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, body: '' });

  const auth = (await route.request().allHeaders()).authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (options.accountStatus !== null && url.pathname === '/api/account') {
    return json(route, options.accountStatus, {});
  }
  if (!state.issuedTokens.has(token)) return json(route, 401, { message: 'unauthorized' });

  if (url.pathname === '/api/account') {
    return json(route, 200, {
      UuId: 'synthetic',
      Persoon: { Id: options.accountPersonId, Roepnaam: 'Synthetic', Achternaam: 'Parent' },
      Groep: [{ Naam: 'Ouder' }],
    });
  }
  const kinderen = /^\/api\/personen\/(\d+)\/kinderen$/.exec(url.pathname);
  if (kinderen) {
    if (Number(kinderen[1]) !== options.accountPersonId) return json(route, 403, {});
    if (options.children.length === 0) return json(route, 404, {});
    return json(route, 200, {
      Items: options.children.map((id) => ({
        Id: id,
        Roepnaam: `Child${id}`,
        Achternaam: 'Synthetic',
        Stamnummer: String(id),
      })),
      TotalCount: options.children.length,
    });
  }
  const afspraken = /^\/api\/personen\/(\d+)\/afspraken$/.exec(url.pathname);
  if (afspraken) {
    const personId = Number(afspraken[1]);
    const van = url.searchParams.get('van') ?? '';
    const tot = url.searchParams.get('tot') ?? '';
    state.scheduleCalls.push(`${personId} ${van} ${tot}`);
    const allowed = [options.accountPersonId, ...options.children];
    if (!allowed.includes(personId)) return json(route, 403, {});
    if (options.scheduleRedirect) {
      return route.fulfill({ status: 302, headers: { location: options.scheduleRedirect } });
    }
    if (options.scheduleInvalid) return json(route, 200, { Items: [{ Start: 42 }] });
    const perDate = options.appointments.get(personId) ?? new Map<string, Appointment[]>();
    const items = [...perDate.entries()]
      .filter(([date]) => date >= van && date <= tot)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, list]) => list);
    return json(route, 200, { Items: items, TotalCount: items.length, Links: [] });
  }
  return json(route, 404, {});
}

async function handleLoginOrigin(route: Route, url: URL, state: FixtureState, origin: string) {
  const request = route.request();
  if (url.pathname === '/account/login' && request.method() === 'POST') {
    const body = JSON.parse(request.postData() ?? '{}');
    state.loginPosts.push({ origin, username: body.username, password: body.password });
    if (body.username === TEST_USERNAME && body.password === TEST_PASSWORD) {
      const session = `sso-${state.ssoSessions.size + 1}-${Date.now()}`;
      state.ssoSessions.add(session);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'set-cookie': `fixture_sso=${session}; Path=/; Secure; SameSite=Lax` },
        body: '{}',
      });
    }
    return json(route, 401, {});
  }
  if (url.pathname === '/account/login' || url.pathname === '/login') {
    return html(route, loginPage(state, origin));
  }
  return route.fulfill({ status: 404, body: '' });
}

async function handleAuth(route: Route, url: URL, state: FixtureState) {
  if (url.pathname === '/connect/authorize') {
    state.authorizeCalls += 1;
    const cookie = cookieValue((await route.request().allHeaders()).cookie, 'fixture_sso');
    if (cookie && state.ssoSessions.has(cookie)) {
      const { options } = state;
      const idToken = 'synthetic-id-token';
      const fragment = options.idTokenOnly
        ? `id_token=${idToken}`
        : `access_token=${issueToken(state)}&id_token=${idToken}&token_type=Bearer&expires_in=3600`;
      const target = `${FIXTURE_SCHOOL}${CALLBACK_PATH}#${fragment}`;
      return html(
        route,
        `<script>setTimeout(() => location.replace(${JSON.stringify(target)}), ${options.authorizeDelayMs});</script>`
      );
    }
    const loginOrigin = state.options.loginOrigin;
    const loginPath = loginOrigin === AUTH ? '/account/login' : '/login';
    return html(
      route,
      `<script>location.replace(${JSON.stringify(`${loginOrigin}${loginPath}`)});</script>`
    );
  }
  return handleLoginOrigin(route, url, state, AUTH);
}

/** Installs the fixture on a context. Must be called before the origin policy. */
export async function installFixture(context: BrowserContext, state: FixtureState): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    state.requests.push(url.href);
    if (url.origin === FIXTURE_SCHOOL) return handleSchool(route, url, state);
    if (url.origin === AUTH) return handleAuth(route, url, state);
    if (url.origin === state.options.loginOrigin) {
      return handleLoginOrigin(route, url, state, url.origin);
    }
    state.external.push(url.href);
    return route.abort('blockedbyclient');
  });
}
