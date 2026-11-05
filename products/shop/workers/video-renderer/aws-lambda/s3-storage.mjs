import { ACCOUNT, BUCKET } from "./config.mjs";

export function singleRequestClient(createClient) {
  return {
    async send(command, options) {
      const client = createClient();
      try { return await client.send(command, options); }
      finally { client.destroy(); }
    },
  };
}

// SDK dependencies are injected so the tests never load credential providers.
export function createStorage({ client, readClient = client, writeClient = client, GetObjectCommand, PutObjectCommand }) {
  return {
    async read(ref, options = {}) {
      const signals = [AbortSignal.timeout(20_000)];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const object = await readClient.send(new GetObjectCommand({
        Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT, Key: ref.key,
      }), { abortSignal: signal });
      options.onRequest?.({ attempts: object.$metadata?.attempts ?? 1, retryDelayMs: object.$metadata?.totalRetryDelay ?? 0 });
      if (object.ContentLength !== ref.size || !object.Body) {
        object.Body?.destroy();
        throw new Error("Unexpected render asset length.");
      }
      const chunks = [];
      let size = 0;
      const abort = () => object.Body.destroy(new Error("Asset read aborted."));
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        for await (const chunk of object.Body) {
          size += chunk.length;
          if (size > ref.size) throw new Error("Render asset exceeds its declared size.");
          chunks.push(chunk);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        object.Body.destroy();
      }
      if (size !== ref.size) throw new Error("Render asset was truncated.");
      return Buffer.concat(chunks, size);
    },
    async write({ key, video, sha256, jobDigest, buildId }) {
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      const object = await writeClient.send(new PutObjectCommand({
        Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT, Key: key, Body: video,
        ContentLength: video.length, ContentType: "video/mp4", ChecksumSHA256: checksum,
        IfNoneMatch: "*", ServerSideEncryption: "AES256",
        Metadata: { sha256, "job-digest": jobDigest, "build-id": buildId },
      }), { abortSignal: AbortSignal.timeout(30_000) });
      if (object.ChecksumSHA256 !== checksum) throw new Error("S3 checksum acknowledgement mismatch.");
      return { etag: object.ETag, sha256 };
    },
  };
}
