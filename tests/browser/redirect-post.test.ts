import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { applyContextPolicy } from '../../src/browser-policy.js';
import { createOriginPolicy } from '../../src/security.js';

let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

describe('browser: credentials never cross an untrusted redirect', () => {
  for (const status of [307, 308]) {
    for (const mode of ['form', 'fetch']) {
      it(`blocks a ${status} ${mode} POST before a real local collector receives its body`, async () => {
        const received: string[] = [];
        const collector = createServer((req, res) => {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            received.push(body);
            res.setHeader('access-control-allow-origin', '*');
            res.end('synthetic collector');
          });
        });
        await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
        try {
          const address = collector.address();
          assert.ok(address && typeof address !== 'string');
          const target = `http://127.0.0.1:${address.port}/collect`;
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext();
          await context.route('https://accounts.magister.net/**', async (route) => {
            if (route.request().method() === 'POST') {
              await route.fulfill({ status, headers: { location: target }, body: '' });
            } else {
              const body =
                mode === 'form'
                  ? '<form action="/submit" method="post"><input name="password" value="synthetic-redirect-sentinel"><button>Submit</button></form>'
                  : "<button onclick=\"fetch('/submit',{method:'POST',body:'password=synthetic-redirect-sentinel'}).catch(()=>{})\">Submit</button>";
              await route.fulfill({ contentType: 'text/html', body });
            }
          });
          const guard = await applyContextPolicy(
            context,
            createOriginPolicy({
              schoolOrigin: 'https://fixture-school.magister.net',
              ssoOrigins: [],
            })
          );
          const page = await context.newPage();
          await page.goto('https://accounts.magister.net/fixture');
          await page
            .locator('button')
            .click()
            .catch(() => undefined);
          await assert.rejects(guard.violation, { code: 'ORIGIN_VIOLATION' });
          await context.close().catch(() => undefined);
          // Observing a violation is insufficient: inspect actual HTTP receipt.
          assert.equal(received.length, 0, 'A forbidden redirect reached the collector');
          assert.equal(
            received.some((body) => body.includes('synthetic-redirect-sentinel')),
            false
          );
        } finally {
          collector.closeAllConnections();
          await new Promise<void>((resolve) => collector.close(() => resolve()));
        }
      });
    }
  }
});
