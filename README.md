# unofficial-magister-mcp

An MCP (Model Context Protocol) server for accessing Dutch school schedules from [Magister](https://www.magister.net). Enables Claude and other MCP-compatible AI assistants to query school schedules, drop-off times, pick-up times, homework and tests (read-only).

> **Note:** This is an unofficial package and is not affiliated with Magister or Iddink Group.

## Why I Built This

As a parent, I found myself constantly checking the Magister app to plan our mornings and afternoons. "What time does school start tomorrow?" "When's the last class on Friday?" These questions came up daily, and I wanted my AI assistant to just... know.

This MCP server lets you ask your AI agent natural questions like:
- "What time do I need to drop off the kids tomorrow?"
- "What's the schedule for next Monday?"
- "When does school end on Wednesday?"

No more app switching. Just ask and plan.

## Features

- **Schedule queries** - Get daily or weekly school schedules
- **Drop-off/pick-up times** - Quickly find first and last class times for planning
- **Homework and tests** - Read-only list of homework and tests from the Magister agenda
- **Parent account support** - Works with both student and parent accounts
- **Interactive login** - You log in yourself (including MFA) in a browser window; the server never needs your password
- **Private session storage** - The session is stored per account with owner-only permissions, outside the package
- **Smart caching** - In-memory 5-minute cache with stale-while-revalidate, per account and child

## Requirements

- Node.js 22 or later
- A Magister account (student or parent)
- Chromium for Playwright (~150MB): `npx playwright install chromium`

## Installation

Build a local copy and point your MCP client at it with an absolute path. This
pins exactly the code you reviewed instead of whatever `npx` downloads.

```bash
git clone https://github.com/yo-han/unofficial-magister-mcp.git
cd unofficial-magister-mcp
npm ci
npx playwright install chromium
npm run build
```

## Logging in

Log in once from a terminal. A Chromium window opens on your school's Magister
page; you type your credentials (and MFA, if any) there yourself.

```bash
MAGISTER_SCHOOL=schoolname node /absolute/path/to/unofficial-magister-mcp/dist/index.js login
```

The command waits up to 10 minutes, checks that the session works against
`/api/account` on your school, and stores it. The MCP server then reuses it
headless. When the session can no longer be refreshed (or after
`MAGISTER_SESSION_MAX_AGE_DAYS`, default 30), tools answer with
`[SESSION_EXPIRED]` and you run `login` again.

To remove the stored session:

```bash
MAGISTER_SCHOOL=schoolname node /absolute/path/to/unofficial-magister-mcp/dist/index.js logout
```

`logout` is local only: it deletes the stored session, but does not revoke
tokens at Magister. A running server notices the logout on its next tool call.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `MAGISTER_SCHOOL` | yes | `schoolname`, `schoolname.magister.net` or `https://schoolname.magister.net` |
| `MAGISTER_PROFILE` | no | Name to keep several accounts apart (default: `MAGISTER_USER`, else `default`); only stored hashed |
| `MAGISTER_CHILD_ID` | no | Parent accounts: the child to use (default: the first linked child) |
| `MAGISTER_STATE_DIR` | no | Absolute directory for session state (not inside the package, not a shared tmp dir) |
| `MAGISTER_PERSIST_SESSION` | no | `true` (default) or `false`; with `false` nothing is stored and `login` is refused |
| `MAGISTER_SESSION_MAX_AGE_DAYS` | no | Maximum session age in days (default 30, max 365) |
| `MAGISTER_SSO_ORIGINS` | no | Comma-separated exact `https://` origins of your school's SSO provider, if it uses one |
| `MAGISTER_AUTH_MODE` | no | `interactive` (default) or `password` |
| `MAGISTER_USER`, `MAGISTER_PASS` | password mode only | Credentials for unattended login |
| `MAGISTER_DEBUG` | no | `1` for debug events on stderr |

A `.env` file in the working directory is read at startup (see `.env.example`).

### Where the session is stored

- macOS: `~/Library/Application Support/unofficial-magister-mcp/`
- Linux: `$XDG_STATE_HOME/unofficial-magister-mcp/` or `~/.local/state/unofficial-magister-mcp/`
- Windows: `%LOCALAPPDATA%\unofficial-magister-mcp\` (permission checks are best-effort there)

Each account gets a directory named after a hash of school and profile
(mode `0700`) with a `session.json` (mode `0600`). Symlinks and files owned by
another user are refused. The file contains **unencrypted bearer state**
(cookies and an access token): anyone who can read it can use your Magister
session. It is not a password vault.

### SSO

The browser may only navigate to your school origin, `https://accounts.magister.net`
and the origins in `MAGISTER_SSO_ORIGINS`. If your school signs in through
another provider, add its exact origin(s), for example
`MAGISTER_SSO_ORIGINS=https://login.example-school.nl`. Any other navigation,
redirect stops the login with `[ORIGIN_VIOLATION]`. All popup windows are
blocked, including popups on an allowed origin: the login flow must stay in
the same browser window.

### Password mode

`MAGISTER_AUTH_MODE=password` lets the server log in unattended with
`MAGISTER_USER` and `MAGISTER_PASS`. Credentials are only typed into a form on
`https://accounts.magister.net`, never on an SSO or other origin. MFA is not
supported in this mode. Prefer interactive login: it keeps your password out
of configuration files.

## Usage with Claude Code

```json
{
  "mcpServers": {
    "magister": {
      "command": "node",
      "args": ["/absolute/path/to/unofficial-magister-mcp/dist/index.js"],
      "env": {
        "MAGISTER_SCHOOL": "schoolname"
      }
    }
  }
}
```

## Privacy: what the model sees

Tool results contain, per lesson: date, start and end time (Europe/Amsterdam),
the lesson description or subject, the first teacher name, the first location
and whether it is cancelled. Drop-off and pick-up answers may quote the text of
a school-wide cancellation notice. Parent and child names and account ids from the account/children endpoints
are not added to tool results or logs. Tokens and raw API responses are not
logged. Lesson and cancellation text comes from Magister and may itself contain
personal information.

`get_homework` and `get_tests` additionally return, per item, the subject, the
type, whether it is completed (when Magister says) and the assignment text as
plain text. That text is written by teachers and reaches the model; it may
contain names or other personal information. Links, attachments and images in
it are dropped and never loaded.

Logs go to stderr as one JSON event per line, with fixed event names and no
free text, URLs or error messages.

## Available Tools

### `get_schedule`

Get the school schedule for a specific date.

**Parameters:**
- `date` (required): Date string - "today", "tomorrow", weekday name, or YYYY-MM-DD format

**Example response:**
```
Schedule for Sat Jan 04 2025:

08:30 - 09:20: Mathematics (Mr. de Vries) @ Room 101
09:25 - 10:15: Dutch (Ms. Jansen) @ Room 203
10:30 - 11:20: English (Mr. Smith) @ Room 105
```

### `get_week_schedule`

Get the school schedule for the next 7 days.

**Parameters:** None

### `get_dropoff_time`

Get the first class time for drop-off planning.

**Parameters:**
- `date` (required): Date string - "today", "tomorrow", weekday name, or YYYY-MM-DD format

**Example response:**
```
First class on Mon Jan 06 2025: Mathematics at 08:30 @ Room 101
```

### `get_pickup_time`

Get the last class end time for pick-up planning.

**Parameters:**
- `date` (required): Date string - "today", "tomorrow", weekday name, or YYYY-MM-DD format

**Example response:**
```
Last class on Mon Jan 06 2025: History ends at 15:45 @ Room 301
```

### `get_homework`

Get homework from the Magister agenda for a period.

**Parameters** (both optional):
- `from`: first day, default today
- `to`: last day, default 13 days after `from`

Both accept "today", "tomorrow", a weekday name (its next occurrence, counted
from today) or YYYY-MM-DD, in Europe/Amsterdam. The period is inclusive and at
most 31 days; `from` after `to` (for example `friday` to `monday` when Monday
comes first) is `[INVALID_ARGUMENT]`.

**Examples:** `{}` (the next 14 days) or `{ "from": "2026-11-16", "to": "2026-11-22" }`.

**Example response:**
```
Homework from Mon Nov 16 2026 to Sun Nov 22 2026:

Thu Nov 19 2026 09:20 - 10:10: English (Huiswerk)
  Completed: no
  Content:
    Exercise 5

Fri Nov 20 2026 10:00 - 10:50: Mathematics (Huiswerk) [CANCELLED]
  Completed: unknown
  Content: (no content)
```

`Completed` is `yes`, `no` or `unknown` (Magister did not say). Completed and
cancelled items stay in the list. HTML in the assignment is turned into plain
text (paragraphs, line breaks and list items are kept); scripts, styles,
embedded content, link targets and images are dropped, and very long texts are
cut at 10,000 characters with `… [truncated]`.

### `get_tests`

Get tests from the Magister agenda for a period. Same parameters, defaults and
output as `get_homework`; the type is one of:

| Magister InfoType | Type |
|---|---|
| 2 | Proefwerk |
| 3 | Tentamen |
| 4 | Schriftelijke overhoring |
| 5 | Mondelinge overhoring |

Homework is InfoType 1. Other agenda items (information, notes) are not
returned by either tool.

**Scope:** both tools read agenda items (the same API call as the schedule).
Separate ELO assignments ("Opdrachten") are not fetched, and nothing is ever
marked as done or submitted.

## How It Works

1. **Login**: `login` opens Chromium; the access token is taken from the OIDC callback on your school origin only (never an `id_token`)
2. **Session**: Stored privately per account; restored headless and checked against `/api/account` (a different account is `[SESSION_MISMATCH]`)
3. **Refresh**: An expired token is renewed silently through the existing Magister session; if that needs a login form, you get `[SESSION_EXPIRED]`
4. **API access**: Requests go to your exact school origin, never follow redirects, and responses are schema-validated
5. **Caching**: In memory only, per account and child, one entry per day (at most 64 days, least recently used first out), 5 minutes fresh, at most 30 minutes stale; the schedule, homework and tests share one cache, so asking for all three over the same days within those 5 minutes costs one API call (a stale hit is answered from the cache and refreshed with one call in the background)

A Magister error is reported as an error (`[UPSTREAM_UNAVAILABLE]` or
`[UPSTREAM_INVALID_RESPONSE]`), never as an empty schedule. A response that
announces more items than it contains (`TotalCount`), or more than 2,000 items,
is `[UPSTREAM_INVALID_RESPONSE]` rather than a silently incomplete list.

## Parent Accounts

With a parent account the server uses the first linked child, or the child set
with `MAGISTER_CHILD_ID`. Names from the children endpoint are not exposed.

## Not supported

- MFA in password mode
- Revoking tokens at Magister on `logout`
- Several children in one server (run one server per child with `MAGISTER_CHILD_ID`)
- Encrypted session storage

## Troubleshooting

### `[NOT_LOGGED_IN]` or `[SESSION_EXPIRED]`

Run the `login` command (see above) with the same `MAGISTER_SCHOOL` and
`MAGISTER_PROFILE` as the server.

### `[ORIGIN_VIOLATION]`

The login tried to leave the allowed origins. If your school uses an SSO
provider, add its origin to `MAGISTER_SSO_ORIGINS`.

### New tools do not show up

MCP clients (Claude Code, Claude Desktop, Codex) read the tool list when they
start the server. After updating, run `npm run build` and restart the client.
No credentials belong in the client configuration; the server keeps using the
stored session.

### Cleaning up files from older versions

Before these hardening changes, the server stored state in the package directory and wrote a log and
screenshots to `/tmp`. They may contain session data or a screenshot of the
filled-in login form. This version ignores them; remove them from the package
directory with:

```bash
rm -f .auth-state.json .schedule-cache.json /tmp/magister-mcp.log /tmp/magister-before-login.png /tmp/magister-login-failed.png
```

## Live check

Automated tests run against a synthetic Magister and do not prove that real
authentication works. To check against your own account:

1. `npm run build`, then run `login` as above.
2. Start the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
   with `npx @modelcontextprotocol/inspector node /absolute/path/to/dist/index.js`
   and the same environment variables.
3. Call each tool: `get_schedule` (`today` and a date with known lessons),
   `get_week_schedule`, `get_dropoff_time`, `get_pickup_time`, `get_homework`
   and `get_tests` (`{}` and a period with known homework or tests).
4. Treat "No classes scheduled" or "No homework found" (an empty period) and a
   `[CODE]` error as different outcomes; report them separately.
5. Do not paste real responses into GitHub issues: they contain your child's
   schedule.

## Development

```bash
# Clone the repository
git clone https://github.com/yo-han/unofficial-magister-mcp.git
cd unofficial-magister-mcp

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run linting
npm run lint

# Run tests (unit, synthetic-browser and protocol; build first)
npm run build
npm test

# Protocol smoke test against dist/ (no credentials, no network)
npm run smoke

# Format code
npm run format
```

## License

MIT - see [LICENSE](LICENSE)

## Disclaimer

This is an unofficial tool that interacts with Magister.net through browser automation. It may break if Magister changes their website. Use at your own risk.

The author is not affiliated with Magister, Schoolmaster B.V., Iddink Group, or any of their subsidiaries. "Magister" is a trademark of Iddink Group.
