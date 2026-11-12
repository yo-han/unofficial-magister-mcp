/**
 * The real MCP server (createServer + MagisterClient) on stdio, wired to the
 * route fixture instead of Magister. Used by tests/mcp-browser.test.ts.
 *
 * It logs in once through the fixture (headless), seeds a synthetic week and
 * then serves. FIXTURE_NOW pins "today".
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { interactiveLogin } from '../../src/auth.js';
import { MagisterClient } from '../../src/magister.js';
import { createServer } from '../../src/server.js';
import { createHarness } from './harness.js';
import { allDayNotice, CHILD_A, lesson, setAppointments } from './magister-routes.js';

const now = new Date(process.env.FIXTURE_NOW ?? '2026-11-16T07:00:00Z');

const harness = await createHarness();
setAppointments(harness.state, CHILD_A, '2026-11-16', [
  lesson('2026-11-16', '08:30', '09:20', 'Wiskunde'),
  lesson('2026-11-16', '09:20', '10:10', 'Engels'),
  lesson('2026-11-16', '14:00', '14:50', 'Biologie'),
]);
setAppointments(harness.state, CHILD_A, '2026-11-17', [
  allDayNotice('2026-11-17', '2026-11-18', 'Alle lessen vervallen i.v.m. studiedag'),
]);
await interactiveLogin(harness.deps);

const client = new MagisterClient(harness.deps);
const server = createServer({
  version: '0.0.0-fixture',
  clientFactory: () => client,
  now: () => now,
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await client.close();
  await harness.cleanup();
  process.exit(0);
};
process.stdin.once('end', () => void stop());
process.once('SIGTERM', () => void stop());

await server.connect(new StdioServerTransport());
