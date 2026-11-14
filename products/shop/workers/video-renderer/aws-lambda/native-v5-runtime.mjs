import { pathToFileURL } from 'node:url';

/** Route the original handlers without changing their event or binding checks. */
export function createNativeV5Handler({ v5, app, failure }) {
  return async (event, context) => {
    if (event?.kind === 'product-image-v5') return v5(event, context);
    if (Array.isArray(event?.Records)) return failure(event, context);
    return app(event, context);
  };
}

async function handler(event, context) {
  if (event?.kind === 'product-image-v5') return (await import('../../../../../../native-image/product-image-v5-entry.mjs')).handler(event, context);
  if (Array.isArray(event?.Records)) return (await import('./failure-entry.mjs')).handler(event, context);
  return (await import('./app-entry.mjs')).handler(event, context);
}

// The Runtime API endpoint is installed by Lambda, never taken from an event.
export async function runNativeV5Runtime({ endpoint = process.env.AWS_LAMBDA_RUNTIME_API, send = fetch,
    invoke = handler, now = Date.now, signal } = {}) {
  if (typeof endpoint !== 'string' || !/^(?:[a-z0-9][a-z0-9.-]*|\d{1,3}(?:\.\d{1,3}){3}):[1-9]\d{0,4}$/.test(endpoint))
    throw Error('Expected the installed Lambda Runtime API endpoint.');
  const origin = `http://${endpoint}/2018-06-01/runtime`;
  while (!signal?.aborted) {
    const next = await send(`${origin}/invocation/next`, { signal, redirect: 'error' });
    if (next.status !== 200) throw Error('Lambda next-invocation request failed.');
    const requestId = next.headers.get('lambda-runtime-aws-request-id');
    const invokedFunctionArn = next.headers.get('lambda-runtime-invoked-function-arn');
    const deadline = Number(next.headers.get('lambda-runtime-deadline-ms'));
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(requestId ?? '') || typeof invokedFunctionArn !== 'string' ||
        !/^arn:aws:lambda:ap-southeast-2:\d{12}:function:[a-zA-Z0-9_-]+(?::(?:[1-9]\d*|\$LATEST))?$/.test(invokedFunctionArn) || !Number.isSafeInteger(deadline) || deadline <= now())
      throw Error('Lambda invocation identity is incomplete.');
    const invocationId = next.headers.get('lambda-runtime-invocation-id');
    if (invocationId !== null && !/^[a-zA-Z0-9-]{1,128}$/.test(invocationId)) throw Error('Invalid Lambda invocation attempt.');
    const trace = next.headers.get('lambda-runtime-trace-id');
    if (trace) process.env._X_AMZN_TRACE_ID = trace; else delete process.env._X_AMZN_TRACE_ID;
    let result, failed = false;
    try {
      const bytes = await next.arrayBuffer();
      if (bytes.byteLength > 6 * 1024 * 1024) throw Error('Lambda invocation exceeds the event bound.');
      result = await invoke(JSON.parse(Buffer.from(bytes).toString('utf8')), { awsRequestId: requestId, invokedFunctionArn,
        functionName: process.env.AWS_LAMBDA_FUNCTION_NAME, functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
        getRemainingTimeInMillis: () => Math.max(0, deadline - now()) });
    } catch {
      // Event payloads, grants and provider errors remain out of runtime errors.
      failed = true; result = { errorType: 'NativeInvocationError', errorMessage: 'Native invocation failed; inspect the admitted job receipt.' };
    }
    const posted = await send(`${origin}/invocation/${requestId}/${failed ? 'error' : 'response'}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(invocationId ? { 'lambda-runtime-invocation-id': invocationId } : {}), ...(failed ? { 'lambda-runtime-function-error-type': 'NativeInvocationError' } : {}) },
      body: JSON.stringify(result ?? null), signal, redirect: 'error' });
    await posted.body?.cancel();
    if (posted.status !== 202) throw Error('Lambda invocation receipt was rejected.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeV5Runtime().catch(() => { console.error('Native Lambda runtime stopped.'); process.exitCode = 1; });
}
