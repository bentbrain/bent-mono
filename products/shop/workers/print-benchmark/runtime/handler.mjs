import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ACCOUNT, REGION, BUCKET, check, assertRuntime, validateInvocation } from './contract.mjs';
import { renderPrint } from './render.mjs';

let first = true;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function handler(event, context) {
  const started = performance.now(), startedAt = Date.now(), firstInvocationInProcess = first;
  first = false;
  assertRuntime(process.env, context);
  const fixtures = JSON.parse(await readFile(new URL('./plans.json', import.meta.url), 'utf8'));
  const { fixture, sourceKey, outputPrefix } = validateInvocation(event, fixtures);
  const client = new S3Client({ region: REGION, maxAttempts: 1, credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN } });
  try {
    const readStarted = performance.now();
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey, ExpectedBucketOwner: ACCOUNT }),
      { abortSignal: AbortSignal.timeout(15000) });
    check(response.ContentLength === fixture.bytes && response.Body, 'source length');
    const chunks = []; let length = 0;
    for await (const chunk of response.Body) { length += chunk.length; check(length <= fixture.bytes, 'bounded read'); chunks.push(chunk); }
    const source = Buffer.concat(chunks);
    check(length === fixture.bytes && sha(source) === fixture.sha256, 'source integrity');
    const sourceReadMs = performance.now() - readStarted;
    const outputs = await Promise.all(fixture.plans.map(async plan => {
      const renderStarted = performance.now(), bytes = await renderPrint(source, plan);
      const renderMs = performance.now() - renderStarted, digest = sha(bytes);
      check(bytes.length > 0 && bytes.length <= 30000000, 'print byte budget');
      const key = `${outputPrefix}${plan.width}x${plan.height}.png`, writeStarted = performance.now();
      const saved = await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes,
        ExpectedBucketOwner: ACCOUNT, IfNoneMatch: '*', ContentType: 'image/png',
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64') }), { abortSignal: AbortSignal.timeout(15000) });
      check(saved.VersionId && saved.VersionId !== 'null', 'versioned storage acknowledgement');
      return { key, version: saved.VersionId, sha256: digest, bytes: bytes.length,
        width: plan.width, height: plan.height, renderMs, storageWriteMs: performance.now() - writeStarted };
    }));
    return { fixture: fixture.name, requestId: context.awsRequestId, startedAt, completedAt: Date.now(), firstInvocationInProcess, sourceReadMs, handlerMs: performance.now() - started,
      maxRssKiB: process.resourceUsage().maxRSS, outputs };
  } finally { client.destroy(); }
}
