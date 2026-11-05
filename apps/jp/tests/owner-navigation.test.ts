import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showOwnerNavigation } from '../src/lib/owner-navigation';

const email = 'owner@example.test';
void test('production navigation requires the configured sole owner and admin role', () => {
  assert.equal(showOwnerNavigation({ email, role: 50 }, email, false), true);
  assert.equal(showOwnerNavigation({ email, role: 49 }, email, false), false);
  assert.equal(
    showOwnerNavigation(
      { email: 'other@example.test', role: 100 },
      email,
      false,
    ),
    false,
  );
  assert.equal(
    showOwnerNavigation({ email, role: 50 }, undefined, false),
    false,
  );
  assert.equal(showOwnerNavigation(null, email, false), false);
  assert.equal(showOwnerNavigation(undefined, email, false), false);
});

void test('development navigation uses the existing local emDash administrator', () => {
  assert.equal(showOwnerNavigation({ email, role: 50 }, undefined, true), true);
  assert.equal(
    showOwnerNavigation({ email, role: 49 }, undefined, true),
    false,
  );
  assert.equal(showOwnerNavigation(undefined, undefined, true), false);
});
