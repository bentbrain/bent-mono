import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { homeCommandSchema } from "../src/lib/home-control-types.ts";
import { getHomeState, runHomeCommand } from "../src/lib/home-assistant.ts";
import { wifiPasswordSchema } from "../src/lib/wifi-types.ts";
import { wifiStore } from "./wifi-store.mjs";

// Fixed device commands, filtered state and private Wi-Fi settings cross this bridge.
// Home Assistant credentials and its general API never leave the Mac mini.
export function createHomeBridge({
  token,
  read = getHomeState,
  write = runHomeCommand,
  wifiRead = wifiStore.read,
  wifiWrite = wifiStore.write,
}) {
  if (!token || token.length < 32)
    throw new Error("A strong bridge token is required.");
  let reads = 0;
  let writes = 0;
  let reset = Date.now() + 60_000;
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 },
    async (request, response) => {
      function reply(status, data) {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        });
        response.end(JSON.stringify(data));
      }
      const received = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        reply(401, { error: "Unauthorized." });
        return;
      }
      if (Date.now() >= reset) {
        reads = 0;
        writes = 0;
        reset = Date.now() + 60_000;
      }
      if (
        ["/state", "/wifi"].includes(request.url) &&
        request.method === "GET"
      ) {
        if (++reads > 120) {
          reply(429, { error: "Try again shortly." });
          return;
        }
        try {
          reply(200, await (request.url === "/wifi" ? wifiRead() : read()));
        } catch {
          reply(503, { error: "Controls unavailable." });
        }
        return;
      }
      if (
        !["/command", "/wifi"].includes(request.url) ||
        request.method !== "POST"
      ) {
        reply(404, { error: "Not found." });
        return;
      }
      if (++writes > 60) {
        reply(429, { error: "Try again shortly." });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        reply(415, { error: "JSON required." });
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) {
            reply(413, { error: "Request too large." });
            return;
          }
          chunks.push(chunk);
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reply(400, { error: "Invalid command." });
          return;
        }
        const parsed = (
          request.url === "/wifi" ? wifiPasswordSchema : homeCommandSchema
        ).safeParse(data);
        if (!parsed.success) {
          reply(400, { error: "Invalid command." });
          return;
        }
        try {
          await (request.url === "/wifi"
            ? wifiWrite(parsed.data)
            : write(parsed.data));
          reply(200, { ok: true });
        } catch {
          reply(503, { error: "Command unavailable." });
        }
      } catch {
        if (!response.headersSent) reply(400, { error: "Invalid request." });
      }
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.HOME_CONTROL_BRIDGE_PORT || 18231);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid bridge port.");
  if (!process.env.HOME_ASSISTANT_URL || !process.env.HOME_ASSISTANT_TOKEN)
    throw new Error("Home Assistant credentials are required.");
  const server = createHomeBridge({
    token: process.env.HOME_CONTROL_BRIDGE_TOKEN,
  });
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `Apartment controls bridge listening on localhost:${port}\n`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
