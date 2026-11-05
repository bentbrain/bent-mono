import assert from 'node:assert/strict';
import test from 'node:test';
import { isKnownProbe } from '../src/lib/request-guard';

void test('known secret-file and unrelated platform probes stop before CMS work', () => {
  for (const path of [
    '/.env',
    '/.env.local',
    '/.ENV.production',
    '/.git/config',
    '/.git/objects/123',
    '/.svn/entries',
    '/%2eenv',
    '/%252Egit%252Fconfig',
    '/wp-login.php',
    '/admin_phpinfo.php',
    '/administrator/.env',
    '/config/aws.json',
    '/package-updates/perform.cgi',
    '/servers/link.cgi',
  ])
    assert.equal(isKnownProbe(path), true, path);
});

void test('normal browsing, media, authentication and integrations are untouched', () => {
  for (const path of [
    '/',
    '/gallery',
    '/posts/environment',
    '/posts/wp-login.php',
    '/media/.env',
    '/.environment',
    '/.gitbook/page',
    '/.well-known/security.txt',
    '/robots.txt',
    '/sitemap.xml',
    '/_emdash/api/auth/passkey/options',
    '/_emdash/api/media/file/trip/photo.jpg',
    '/_emdash/api/plugins/japan-newsletter/image',
    '/newsletter/confirm',
    '/api/trip/upload',
    '/owner',
    '/malformed%path',
  ])
    assert.equal(isKnownProbe(path), false, path);
});
