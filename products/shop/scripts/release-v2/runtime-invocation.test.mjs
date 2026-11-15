import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowEntrypoint, deliverWorkflow } from './workflow-entrypoint.mjs';
import { admitHostedInvocation, hostedController, withHostedReleaseSession } from './hosted-controller.mjs';
import { hostedReporting } from './hosted-reporting.mjs';

test('file-owned invocation options cannot supply runtime identity or provider boundaries at any entry', async () => {
  const entries = [workflowEntrypoint, deliverWorkflow, admitHostedInvocation, hostedController, hostedReporting,
    (options, env) => withHostedReleaseSession(options, env, {}, () => assert.fail('Unexpected release session'))];
  for (const entry of entries) for (const field of ['env', 'identity', 'boundaries']) {
    await assert.rejects(entry({ [field]: { GITHUB_SHA: '1'.repeat(40) } }, {}), /identity and provider boundaries come from protected runtime/);
  }
});
