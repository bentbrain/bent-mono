import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePreviewToken, verifyPreviewToken } from 'emdash';
import {
  savedImageProof,
  savedImageRecovery,
} from '../src/lib/saved-image-recovery';
import { savedPostImage } from '../src/lib/saved-post-image';

const secret = `emdash_enc_v1_${Buffer.alloc(32).toString('base64url')}`;
const nextSecret = `emdash_enc_v1_${Buffer.alloc(32, 1).toString('base64url')}`;
const binding = {
  origin: 'https://jp.bent.build',
  postId: '01K00000000000000000000000',
  createdAt: '2026-10-15T00:00:00Z',
  principalId: 'synthetic-owner',
  source: 'https://legacy.example.invalid/saved.png',
};

void test('saved-reference MAC binds every authority field and rejects tampering and other purposes', async () => {
  const recovery = await savedImageRecovery(secret);
  const proof = await recovery.sign(binding);
  assert.ok(savedImageProof.safeParse(proof).success);
  assert.equal(await recovery.verify(proof, binding), true);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = proof.at(-1);
  assert.ok(last);
  const noncanonical =
    proof.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) + 1);
  assert.ok(savedImageProof.safeParse(noncanonical).success);
  assert.deepEqual(
    Buffer.from(noncanonical.split('.').at(-1) ?? '', 'base64url'),
    Buffer.from(proof.split('.').at(-1) ?? '', 'base64url'),
    'noncanonical alias decodes to the same MAC bytes',
  );
  for (const changed of [
    { ...binding, origin: 'https://other.example.invalid' },
    { ...binding, postId: '01K00000000000000000000001' },
    { ...binding, createdAt: '2026-10-16T00:00:00Z' },
    { ...binding, principalId: 'other-owner' },
    { ...binding, source: 'https://legacy.example.invalid/unsaved.png' },
  ])
    assert.equal(await recovery.verify(proof, changed), false);
  for (const invalid of [
    noncanonical,
    proof.replace(/^v1/, 'v2'),
    proof + 'A',
    proof.slice(0, -1),
    proof.slice(0, -2) + 'AA',
    'A'.repeat(20_000),
    await generatePreviewToken({
      contentId: `posts:${binding.postId}`,
      secret,
    }),
  ])
    assert.equal(await recovery.verify(invalid, binding), false);
  assert.equal(
    (await verifyPreviewToken({ token: proof, secret })).valid,
    false,
  );
  await assert.rejects(
    savedImageRecovery(undefined),
    /authorization unavailable/,
  );
  await assert.rejects(
    recovery.sign({
      ...binding,
      source: 'https://legacy.example.invalid/' + 'a'.repeat(8192),
    }),
  );
});

void test('proofs outlive revision/session time while configured key rotation and revocation remain effective', async (t) => {
  const old = await savedImageRecovery(secret);
  const proof = await old.sign(binding);
  t.mock.method(Date, 'now', () => Date.UTC(2099, 0, 1));
  assert.equal(await old.verify(proof, binding), true);
  const rotated = await savedImageRecovery(`${nextSecret},${secret}`);
  assert.equal(await rotated.verify(proof, binding), true);
  assert.equal(await old.verify(await rotated.sign(binding), binding), false);
  assert.equal(
    await (await savedImageRecovery(nextSecret)).verify(proof, binding),
    false,
  );
});

void test('real source authorization requires fresh current state, principal and post identity even after history eviction', async () => {
  const signer = await savedImageRecovery(secret);
  const sourceProof = await signer.sign(binding);
  const input = {
    id: binding.postId,
    revision: 'fresh',
    source: binding.source,
    sourceProof,
  };
  const post = {
    success: true,
    data: {
      _rev: 'fresh',
      item: {
        id: binding.postId,
        type: 'posts',
        createdAt: binding.createdAt,
        data: { content: [] },
      },
    },
  };
  let reads = 0;
  let verifications = 0;
  const recovery = {
    principalId: binding.principalId,
    verify: async (proof: string, value: typeof binding) => {
      verifications++;
      return signer.verify(proof, value);
    },
  };
  const read = () => {
    reads++;
    return Promise.resolve(
      new Response('synthetic original', {
        headers: { 'Content-Type': 'image/png' },
      }),
    );
  };
  const history = () => Promise.resolve({ success: false });
  const get = () => Promise.resolve(post);
  const response = await savedPostImage(
    input,
    binding.origin,
    get,
    read,
    history,
    recovery,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'synthetic original');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const verified = verifications;
  assert.equal(
    (
      await savedPostImage(
        { ...input, revision: 'stale' },
        binding.origin,
        get,
        read,
        history,
        recovery,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await savedPostImage(
        input,
        binding.origin,
        () => Promise.resolve({ success: false }),
        read,
        history,
        recovery,
      )
    ).status,
    404,
  );
  assert.equal(
    verifications,
    verified,
    'stale and deleted posts reject before proof verification',
  );
  for (const changed of [
    { ...input, source: 'https://legacy.example.invalid/invented.png' },
    { ...input, sourceProof: sourceProof.slice(0, -2) + 'AA' },
    { ...input, sourceRevision: '01K00000000000000000000001' },
    { ...input, sourceProof: undefined },
  ])
    assert.equal(
      (
        await savedPostImage(
          changed,
          binding.origin,
          get,
          read,
          history,
          recovery,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await savedPostImage(input, binding.origin, get, read, history, {
        ...recovery,
        principalId: 'other-owner',
      })
    ).status,
    400,
  );
  for (const item of [
    { ...post.data.item, id: '01K00000000000000000000001' },
    { ...post.data.item, type: 'media_items' },
    { ...post.data.item, createdAt: '2026-10-16T00:00:00Z' },
  ])
    assert.equal(
      (
        await savedPostImage(
          input,
          binding.origin,
          () => Promise.resolve({ ...post, data: { ...post.data, item } }),
          read,
          history,
          recovery,
        )
      ).status,
      400,
    );
  const revoked = await savedImageRecovery(nextSecret);
  assert.equal(
    (
      await savedPostImage(input, binding.origin, get, read, history, {
        principalId: binding.principalId,
        verify: (proof, value) => revoked.verify(proof, value),
      })
    ).status,
    400,
  );
  assert.equal(reads, 1, 'invalid proof/binding never acquires source bytes');
});
