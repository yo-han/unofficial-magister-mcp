import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_ORIGIN, createOriginPolicy } from '../src/security.js';

const policy = createOriginPolicy({
  schoolOrigin: 'https://mencia.magister.net',
  ssoOrigins: ['https://login.example.org'],
});

describe('createOriginPolicy', () => {
  it('allows navigation to the school, auth and configured SSO origins', () => {
    assert.equal(
      policy.isNavigationAllowed('https://mencia.magister.net/magister/#/vandaag'),
      true
    );
    assert.equal(policy.isNavigationAllowed(`${AUTH_ORIGIN}/account/login?x=1`), true);
    assert.equal(policy.isNavigationAllowed('https://login.example.org/saml'), true);
    assert.equal(policy.isNavigationAllowed('about:blank'), true);
  });

  for (const url of [
    'https://mencia.magister.net.evil.example/',
    'https://evilmencia.magister.net/',
    'https://other.magister.net/',
    'https://mencia.magister.net@evil.example/',
    'https://user:pass@mencia.magister.net/',
    'https://mencia.magister.net:444/',
    'http://mencia.magister.net/',
    'https://accounts.magister.net.evil.example/',
    'http://accounts.magister.net/',
    'https://evil.example/?next=https://mencia.magister.net/',
    'https://login.example.org.evil.example/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'chrome-error://chromewebdata/',
    'not a url',
  ]) {
    it(`blocks navigation to ${url}`, () => {
      assert.equal(policy.isNavigationAllowed(url), false);
    });
  }

  it('treats only the exact school origin as the school', () => {
    assert.equal(
      policy.isSchoolOrigin('https://mencia.magister.net/oidc/redirect_callback.html'),
      true
    );
    assert.equal(policy.isSchoolOrigin('https://mencia.magister.net.evil.example/'), false);
    assert.equal(policy.isSchoolOrigin('https://user@mencia.magister.net/'), false);
    assert.equal(policy.isSchoolOrigin(AUTH_ORIGIN), false);
  });

  it('only allows credential entry on the Magister auth origin', () => {
    assert.equal(policy.isCredentialOrigin(`${AUTH_ORIGIN}/account/login`), true);
    assert.equal(policy.isCredentialOrigin('https://login.example.org/'), false);
    assert.equal(policy.isCredentialOrigin('https://mencia.magister.net/'), false);
    assert.equal(policy.isCredentialOrigin('https://accounts.magister.net.evil.example/'), false);
    assert.equal(policy.isCredentialOrigin('https://user@accounts.magister.net/'), false);
  });
});
