import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackConfiguration } from '../src/lib/feedback';

void test('toolbar configuration accepts only a complete project and exact HTTPS origin', () => {
  const project = 'prj_bc74b93bb6f44574';
  assert.equal(feedbackConfiguration(), null);
  assert.deepEqual(
    feedbackConfiguration('https://toolbar.bent.build', project),
    {
      server: 'https://toolbar.bent.build',
      projectId: project,
    },
  );
  for (const origin of [
    'http://toolbar.bent.build',
    'https://toolbar.bent.build/',
    'https://toolbar.bent.build/path',
    'https://user:password@toolbar.bent.build',
    'https://toolbar.bent.build?redirect=other',
    'javascript:alert(1)',
  ])
    assert.throws(() => feedbackConfiguration(origin, project));
  assert.throws(() => feedbackConfiguration('https://toolbar.bent.build'));
  assert.throws(() => feedbackConfiguration(undefined, project));
  assert.throws(() =>
    feedbackConfiguration('https://toolbar.bent.build', 'invalid'),
  );
});
