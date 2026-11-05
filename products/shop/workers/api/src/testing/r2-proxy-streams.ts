// Node's getPlatformProxy transport loses the known length on R2 body streams.
// This fixture adapter materializes only test data crossing that proxy. Actual
// Worker R2 get-body -> put is checked separately in native qualification.
export function fixtureR2Streams(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put") {
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const [key, value, options] = args;
          return target.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options);
        };
      }
      const reflected: unknown = Reflect.get(target, property); return reflected;
    },
  });
}
