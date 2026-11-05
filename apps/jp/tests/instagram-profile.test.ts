import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagramProfile } from '../src/lib/instagram-profile';

void test('profile URLs produce a handle and canonical HTTPS profile link', () => {
  for (const value of [
    'https://www.instagram.com/Sample.travels/',
    'https://instagram.com/Sample.travels?igsh=synthetic',
    'http://instagram.com/Sample.travels/#sample',
    'instagram.com/Sample.travels',
    '  WWW.INSTAGRAM.COM/Sample.travels/?utm_source=sample  ',
  ]) {
    assert.deepEqual(instagramProfile(value), {
      handle: '@Sample.travels',
      href: 'https://www.instagram.com/Sample.travels/',
    });
  }
  assert.ok(instagramProfile(`https://instagram.com/${'a'.repeat(30)}/`));
  assert.ok(instagramProfile('https://instagram.com/a/'));
});

void test('non-profiles, malformed URLs and hostile lookalikes are left alone', () => {
  for (const value of [
    'https://instagram.com/p/ABC/',
    'https://instagram.com/reel/ABC/',
    'https://instagram.com/reels/ABC/',
    'https://instagram.com/stories/sample/123/',
    'https://instagram.com/tv/ABC/',
    'https://instagram.com/share/ABC/',
    'https://instagram.com/explore/',
    'https://instagram.com/ACCOUNTS/',
    'https://instagram.com/direct',
    'https://instagram.com/p/',
    'https://instagram.com/reel/',
    'https://instagram.com/',
    'https://instagram.com/sample/extra',
    'https://instagram.com/sample//',
    'https://instagram.com/.sample/',
    'https://instagram.com/sample./',
    'https://instagram.com/sample..name/',
    `https://instagram.com/${'a'.repeat(31)}/`,
    'https://instagram.com/sample-name/',
    'https://instagram.com/%73ample/',
    'https://instagram.com/other/../sample/',
    'https://instagram.com/./sample/',
    'https://instagram.com/sample/../',
    'https://instagram.com/sample/%2f',
    'https://instagram.com.evil.test/sample/',
    'https://evilinstagram.com/sample/',
    'https://instagrаm.com/sample/',
    'https://instagram.com@evil.test/sample/',
    'https://evil.test@instagram.com/sample/',
    'https://user:pass@instagram.com/sample/',
    'https://instagram.com:444/sample/',
    'https://instagram.com./sample/',
    'https://m.instagram.com/sample/',
    'https://instagram.com\\@evil.test/sample/',
    'javascript://instagram.com/sample/',
    'ftp://instagram.com/sample/',
    '//instagram.com/sample/',
    'https://instagram.com/sam ple/',
    'https://instagram.com/日本/',
    'See https://instagram.com/sample/',
    'https://instagram.com/sample/ and more',
    'https://instagram.com/sample/\nhttps://instagram.com/other/',
    '',
  ]) {
    assert.equal(instagramProfile(value), null, value);
  }
});
